import { createServer } from 'node:http';
import request from 'supertest';
import * as Y from 'yjs';
import { YDOC_TEXT_KEY } from '@collab/shared';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { redis } from '../../src/redis/redis.js';
import { createRedisBus } from '../../src/redis/pubsub.js';
import { createCollaborationHub } from '../../src/services/collaboration.service.js';
import { createRedisRateLimitStore } from '../../src/security/rate-limit-store.js';
import { attachWebSocketServer, closeWebSocketServer } from '../../src/websocket/ws-server.js';
import { connectClient, eventually } from '../helpers/yjs-test-client.js';
import { assertTestDatabase, assertTestRedis, DATABASE_URL, REDIS_URL } from './config.js';

/**
 * Builds real backend instances inside the test process — the same pieces
 * server.js wires together (app, hub, Redis bus, Redis rate-limit store,
 * WebSocket server), each on its own port. Two of them sharing one PostgreSQL
 * and one Redis are two instances behind a load balancer, minus the balancer.
 */

export const CLIENT_ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct-horse-battery';

/** Every table, emptied between tests. Children first is not needed with CASCADE. */
const TABLES = ['document_revisions', 'document_members', 'documents', 'users'];

const running = new Set();
const openClients = [];

export async function resetData() {
  assertTestDatabase(DATABASE_URL);
  assertTestRedis(REDIS_URL);
  const [{ current_database: name }] =
    await prisma.$queryRaw`SELECT current_database() AS current_database`;
  assertTestDatabase(`postgresql://x/${name}`); // the connection really is the test DB
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(', ')} CASCADE`);
  await redis.flushdb();
}

/**
 * Register the standard lifecycle for an integration test file: a clean
 * database before each test, instances and sockets stopped after it,
 * connections released at the end.
 */
export function useIntegrationStack() {
  beforeEach(resetData);
  afterEach(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await Promise.all([...running].map((instance) => instance.stop()));
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });
}

/**
 * Start one backend instance.
 *
 * @param {string} name  instance id, as in production logs
 * @param {{ bus?: boolean }} [options]  bus: false = an instance cut off from
 *   Redis Pub/Sub (a network partition), for merge tests
 */
export async function startInstance(name, { bus: withBus = true } = {}) {
  const bus = withBus ? createRedisBus() : null;
  if (bus) await eventually(() => bus.state === 'up', 5_000);

  const hub = createCollaborationHub({ bus, instanceId: name });
  const rateLimitStore = createRedisRateLimitStore(redis);
  const app = createApp({ hub, rateLimitStore });
  const server = createServer(app);
  const wss = attachWebSocketServer(server, { hub, rateLimitStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  let stopped = false;
  const instance = {
    name,
    app,
    hub,
    server,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    /** The graceful-shutdown steps of server.js, in the same order. */
    async stop() {
      if (stopped) return;
      stopped = true;
      running.delete(instance);
      await closeWebSocketServer(wss, { graceMs: 200 });
      await hub.flushAllSessions();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await bus?.close();
    },
  };
  running.add(instance);
  return instance;
}

/** The refresh cookie a response sets, as `name=value`, or undefined. */
export function refreshCookieOf(res) {
  return (res.headers['set-cookie'] ?? [])
    .find((cookie) => cookie.startsWith('collab_refresh='))
    ?.split(';')[0];
}

/**
 * Register a user through the real API. The supertest agent keeps the refresh
 * cookie, like a browser.
 */
export async function registerUser(instance, name) {
  const agent = request.agent(instance.server);
  const email = `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const res = await agent
    .post('/api/auth/register')
    .set('Origin', CLIENT_ORIGIN)
    .send({ name, email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`);
  return {
    id: res.body.user.id,
    name,
    email,
    token: res.body.accessToken,
    /** `collab_refresh=…`, ready for a Cookie header */
    refreshCookie: refreshCookieOf(res),
    agent,
  };
}

/** Authenticated request helper bound to one instance and one user. */
export function api(instance, user) {
  const auth = (req) => (user ? req.set('Authorization', `Bearer ${user.token}`) : req);
  return {
    get: (url) => auth(request(instance.server).get(url)),
    post: (url, body) => auth(request(instance.server).post(url)).send(body),
    patch: (url, body) => auth(request(instance.server).patch(url)).send(body),
    delete: (url) => auth(request(instance.server).delete(url)),
  };
}

export async function createDocument(instance, owner, name = 'test.js') {
  const res = await api(instance, owner).post('/api/documents', { name, language: 'javascript' });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${res.text}`);
  return res.body.document;
}

export async function share(instance, owner, documentId, user, role) {
  const res = await api(instance, owner).post(`/api/documents/${documentId}/members`, {
    email: user.email,
    role,
  });
  if (res.status !== 201) throw new Error(`share failed: ${res.status} ${res.text}`);
}

/** A ticket for `user` on `documentId`, issued by `instance` (stored in Redis). */
export async function issueTicket(instance, user, documentId) {
  const res = await api(instance, user).post(`/api/documents/${documentId}/ws-ticket`);
  if (res.status !== 200) throw new Error(`ticket failed: ${res.status} ${res.text}`);
  return res.body.ticket;
}

/**
 * A WebSocket client on `instance`, with a ticket issued through the API. Pass
 * `previous` (a disconnected client) to reconnect with its Y.Doc and presence,
 * like a browser after a network blip.
 */
export async function openClient(instance, user, documentId, previous) {
  const ticket = await issueTicket(instance, user, documentId);
  const client = connectClient(instance.wsUrl, ticket, previous?.ydoc, previous?.awareness);
  openClients.push(client);
  return client;
}

/**
 * Poll an *async* condition (a database read) until it holds. The shared
 * `eventually` is synchronous: given an async function it would see a Promise,
 * which is always truthy, and pass without checking anything.
 */
export async function until(check, timeoutMs = 5_000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The text PostgreSQL holds for a document (decoded from its binary Yjs state). */
export async function storedText(documentId) {
  const row = await prisma.document.findUnique({ where: { id: documentId } });
  if (!row?.yjsState) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.yjsState));
  return doc.getText(YDOC_TEXT_KEY).toString();
}

export { connectClient, eventually, prisma, redis };
