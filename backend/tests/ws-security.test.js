import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { WS_CLOSE_CODES } from '@collab/shared';
import { connectClient, eventually } from './helpers/yjs-test-client.js';

/**
 * Phase 11 WebSocket protections on a real server: origin check and connection
 * limit at the HTTP upgrade, message-rate limit per socket, document size cap.
 */

const DOC_ID = '66666666-6666-4666-8666-666666666666';
const EDITOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const db = vi.hoisted(() => ({ tickets: new Map() }));

vi.mock('../src/websocket/ticket.service.js', () => ({
  issueTicket: vi.fn(),
  consumeTicket: vi.fn(async (ticket) => {
    const data = db.tickets.get(ticket) ?? null;
    db.tickets.delete(ticket);
    return data;
  }),
}));
vi.mock('../src/repositories/user.repository.js', () => ({
  findById: vi.fn(async (id) => ({ id, name: 'Editor', email: 'e@x.test' })),
}));
vi.mock('../src/repositories/document.repository.js', () => ({
  getDocumentWithRole: vi.fn(async () => ({ document: { id: DOC_ID }, role: 'EDITOR' })),
  getDocumentState: vi.fn(async () => null),
  withLockedDocumentState: vi.fn(async (_id, fn) =>
    fn({
      current: null,
      writeState: async () => {},
      latestRevision: async () => null,
      revisionSnapshot: async () => null,
      createRevision: async (data) => ({ id: 'r', ...data }),
    }),
  ),
}));

const { attachWebSocketServer, closeWebSocketServer } =
  await import('../src/websocket/ws-server.js');
const { createCollaborationHub } = await import('../src/services/collaboration.service.js');
const { createMemoryRateLimitStore } = await import('../src/security/rate-limit-store.js');

let server;
let wss;
let url;
let ticketSeq = 0;
const clients = [];

beforeAll(async () => {
  server = createServer();
  wss = attachWebSocketServer(server, {
    hub: createCollaborationHub(),
    rateLimitStore: createMemoryRateLimitStore(),
    allowedOrigins: ['http://localhost:5173'],
    messageRate: { perSecond: 1, burst: 20 },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${server.address().port}/ws`;
});

afterAll(async () => {
  await closeWebSocketServer(wss);
  await new Promise((resolve) => server.close(resolve));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function mintTicket() {
  const value = `t-${(ticketSeq += 1)}`;
  db.tickets.set(value, { userId: EDITOR, documentId: DOC_ID });
  return value;
}

/** Resolves with the HTTP status of a refused upgrade, or 101 if it was accepted. */
function upgradeStatus(target, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(target, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('error', () => {});
  });
}

describe('WebSocket upgrade checks', () => {
  it('refuses a handshake from a foreign origin with 403 (cross-site WebSocket hijacking)', async () => {
    expect(await upgradeStatus(`${url}?ticket=x`, { Origin: 'https://evil.example' })).toBe(403);
  });

  it('accepts our own origin and non-browser clients', async () => {
    expect(await upgradeStatus(`${url}?ticket=x`, { Origin: 'http://localhost:5173' })).toBe(101);
    expect(await upgradeStatus(`${url}?ticket=x`)).toBe(101);
  });

  it('answers 404 for any other path', async () => {
    expect(await upgradeStatus(url.replace('/ws', '/other'))).toBe(404);
  });

  it('limits connection attempts per IP (RATE_LIMIT_WS_CONNECT_PER_MINUTE = 30)', async () => {
    const statuses = [];
    // A distinct forwarded address so earlier tests' attempts do not count.
    for (let i = 0; i < 31; i += 1) {
      statuses.push(await upgradeStatus(`${url}?ticket=x`, { 'X-Forwarded-For': '192.0.2.50' }));
    }
    expect(statuses.slice(0, 30).every((s) => s === 101)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe('per-socket protections', () => {
  it('closes a socket that floods messages with a retryable 4029', async () => {
    const client = connectClient(url, mintTicket());
    clients.push(client);
    await client.synced();
    for (let i = 0; i < 40; i += 1) client.send({ type: 'ping' });
    expect((await client.closed).code).toBe(WS_CLOSE_CODES.RATE_LIMITED);
  });

  it('refuses an update that would exceed the document size cap, without applying it', async () => {
    const writer = connectClient(url, mintTicket());
    const reader = connectClient(url, mintTicket());
    clients.push(writer, reader);
    await Promise.all([writer.synced(), reader.synced()]);

    writer.text.insert(0, 'small edit');
    await eventually(() => reader.text.toString() === 'small edit');

    writer.text.insert(0, 'x'.repeat(70_000)); // > 64 KB cap in tests/setup.js
    const error = await writer.waitFor((m) => m.type === 'error');
    expect(error.code).toBe('DOCUMENT_TOO_LARGE');

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reader.text.toString()).toBe('small edit');
  });
});
