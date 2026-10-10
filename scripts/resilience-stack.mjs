// Failure scenarios against the running Docker stack (Phase 12, kept as a
// repeatable test in Phase 13). It stops and starts containers, so it is a
// local test, not a CI step:
//
//   npm run stack:up && npm run stack:resilience
//
// 1. docker stop runs the graceful shutdown; an unsaved edit survives it.
// 2. With every backend down, Nginx answers JSON 503 and still serves the app.
// 3. One instance stops: only its sockets move, editing and the API continue.
// 4. The stopped instance comes back and gets traffic again.
// 5. Redis down: readiness fails, liveness does not, nothing is restarted.
// 6. A request flood is trimmed by Nginx, in the API's JSON format.
// 7. Logs: no tickets, no probes, compact backend lines.
//
// Takes about two minutes. Everything goes through Nginx, like a browser.

import { execSync } from 'node:child_process';
import * as Y from 'yjs';
import { fromBase64, toBase64, YDOC_TEXT_KEY } from '@collab/shared';
import { BASE, WS_BASE } from './lib/target.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, timeoutMs = 15_000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(100);
  }
  return true;
}

// execSync blocks this process's event loop while Docker works: WebSocket
// events queue up meanwhile and are delivered afterwards.
const compose = (args) =>
  execSync(`docker compose --profile app ${args}`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
const logsSince = (service, since) => compose(`logs ${service} --no-log-prefix --since ${since}`);
// One replica of the scaled `backend` service, by its container name.
const docker = (args) =>
  execSync(`docker ${args}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const replica = (n) => `collab-editor-backend-${n}`;
const replicaLogs = (n, since) => docker(`logs ${replica(n)} --since ${since} 2>&1`);
async function startReplica(n) {
  docker(`start ${replica(n)}`);
  await until(
    () => docker(`inspect -f "{{.State.Health.Status}}" ${replica(n)}`).trim() === 'healthy',
    60_000,
  );
}

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Origin: BASE,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, headers: response.headers, json, text };
}

/** The frontend's sync protocol, minus the browser. */
function connect(ticket) {
  const ydoc = new Y.Doc();
  const messages = [];
  let closeCode = null;
  const ws = new WebSocket(`${WS_BASE}/ws?ticket=${encodeURIComponent(ticket)}`);
  const send = (message) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));
  ydoc.on('update', (update, origin) => {
    if (origin !== 'remote') send({ type: 'update', update: toBase64(update) });
  });
  ws.addEventListener('close', (event) => {
    closeCode = event.code;
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    if (message.type === 'joined') {
      send({ type: 'sync-step1', stateVector: toBase64(Y.encodeStateVector(ydoc)) });
    } else if (message.type === 'sync-step1') {
      const update = Y.encodeStateAsUpdate(ydoc, fromBase64(message.stateVector));
      send({ type: 'sync-step2', update: toBase64(update) });
    } else if (message.type === 'sync-step2' || message.type === 'update') {
      Y.applyUpdate(ydoc, fromBase64(message.update), 'remote');
    }
  });
  return {
    text: ydoc.getText(YDOC_TEXT_KEY),
    synced: () => messages.some((m) => m.type === 'sync-step2'),
    get closeCode() {
      return closeCode;
    },
    close: () => ws.close(),
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────
const registered = await api('POST', '/api/auth/register', {
  body: {
    name: 'Resilience',
    email: `resilience-${Date.now()}@example.test`,
    password: 'correct-horse-battery',
  },
});
if (registered.status !== 201) {
  console.error(`Cannot register through ${BASE} (${registered.status}). Is the stack up?`);
  process.exit(1);
}
const token = registered.json.accessToken;
const doc = (
  await api('POST', '/api/documents', { token, body: { name: 'r.js', language: 'javascript' } })
).json.document;
const ticket = async () =>
  (await api('POST', `/api/documents/${doc.id}/ws-ticket`, { token })).json?.ticket;

/**
 * Connect the way the browser client does: on a failed ticket request or a
 * socket that closes before syncing, wait and try again with a fresh ticket.
 * During the first seconds of a failover a request can be routed to the
 * instance that just stopped and fail once (Nginx: 503/504); the browser's
 * backoff absorbs that, so this client must too. Resolves to the client and
 * how many retries it needed.
 */
async function connectLikeABrowser(attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await ticket();
    if (value) {
      const client = connect(value);
      const outcome = await until(() => client.synced() || client.closeCode !== null, 10_000);
      if (outcome && client.synced()) return { client, retries: attempt };
      client.close();
    }
    await sleep(1_000);
  }
  throw new Error('could not connect');
}

/**
 * The backend addresses Nginx used for a burst of probes: an unauthenticated
 * 404, so the polling does not count against the user's API rate limit.
 */
async function routedUpstreams() {
  const since = new Date(Date.now() - 1_000).toISOString();
  for (let i = 0; i < 6; i += 1) await api('GET', '/api/routing-probe');
  return new Set(logsSince('nginx', since).match(/[\d.]+(?=:4000)/g) ?? []);
}

/** Nginx routes to both instances (Docker DNS has caught up after restarts). */
async function bothInstancesRouted() {
  return until(async () => {
    if ((await routedUpstreams()).size >= 2) return true;
    await sleep(500);
    return false;
  }, 30_000);
}

/**
 * Nginx sends traffic to replica `n`. Not "to both": least_conn rightly sends
 * new requests to whichever replica holds fewer of the open WebSockets, so
 * after a restart the probes may all go to the restarted one.
 */
async function replicaRouted(n) {
  const ip = docker(
    `inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" ${replica(n)}`,
  ).trim();
  return until(async () => {
    if ((await routedUpstreams()).has(ip)) return true;
    await sleep(500);
    return false;
  }, 30_000);
}

async function gracefulShutdown() {
  const client = connect(await ticket());
  await until(() => client.synced());
  client.text.insert(0, 'saved-by-graceful-shutdown;');
  await sleep(300); // inside the 2 s save debounce: not persisted yet

  const since = new Date().toISOString();
  compose('stop backend');
  const logs = logsSince('backend', since);
  check(
    'docker stop delivers SIGTERM and both backends shut down gracefully',
    (logs.match(/WebSocket server closed/g) ?? []).length === 2 && !/forcing exit/.test(logs),
  );
  check(
    'open sockets are closed with SERVER_SHUTDOWN (4008)',
    await until(() => client.closeCode === 4008, 5_000),
    `${client.closeCode}`,
  );

  const down = await api('GET', '/api/documents', { token });
  check(
    'with every backend down, the API answers JSON 503 SERVICE_UNAVAILABLE',
    down.status === 503 &&
      down.json?.error?.code === 'SERVICE_UNAVAILABLE' &&
      down.headers.get('retry-after') === '5',
    `${down.status}`,
  );
  const page = await api('GET', '/');
  check('…while Nginx keeps serving the frontend', page.status === 200);

  compose('up -d --wait backend');
  check('after both backends restart, Nginx routes to both again', await bothInstancesRouted());
  const after = connect(await ticket());
  check(
    'the edit made just before SIGTERM was saved by the shutdown',
    await until(() => after.synced() && after.text.toString() === 'saved-by-graceful-shutdown;'),
    JSON.stringify(after.text.toString()),
  );
  after.close();
}

async function failover() {
  const clients = [];
  for (let i = 0; i < 4; i += 1) clients.push(connect(await ticket()));
  await until(() => clients.every((client) => client.synced()));

  docker(`stop ${replica(2)}`);
  await until(() => clients.some((client) => client.closeCode !== null), 5_000);
  await sleep(300);
  const lost = clients.filter((client) => client.closeCode !== null);
  const kept = clients.filter((client) => client.closeCode === null);
  check(
    'stopping backend-2 closes only the sockets it served',
    lost.length > 0 && kept.length > 0,
    `${lost.length} of 4 closed`,
  );

  // Reconnect them, as the browser client does after 4008.
  const moved = [];
  let retries = 0;
  for (let i = 0; i < lost.length; i += 1) {
    const reconnected = await connectLikeABrowser();
    moved.push(reconnected.client);
    retries += reconnected.retries;
  }
  check(
    'their reconnections land on backend-1 and re-sync',
    moved.every((client) => client.synced()),
    `${retries} retr${retries === 1 ? 'y' : 'ies'} needed`,
  );
  kept[0].text.insert(kept[0].text.length, ' after-failover;');
  check(
    'editing continues for everyone on the remaining instance',
    await until(() =>
      [...moved, ...kept].every((client) => client.text.toString().endsWith('after-failover;')),
    ),
  );

  let ok = 0;
  for (let i = 0; i < 20; i += 1) {
    if ((await api('GET', '/api/documents', { token })).status === 200) ok += 1;
  }
  check('the API keeps answering with one instance down', ok === 20, `${ok}/20`);

  const since = new Date().toISOString();
  await startReplica(2);
  check('the restarted backend-2 gets traffic again', await replicaRouted(2));
  const fresh = [];
  for (let i = 0; i < 4; i += 1) fresh.push((await connectLikeABrowser()).client);
  check(
    'new sockets are balanced onto it',
    /ws connection authenticated/.test(replicaLogs(2, since)),
  );
  for (const client of [...clients, ...moved, ...fresh]) client.close();
}

async function redisOutage() {
  compose('stop redis');
  const degraded = await until(async () => (await api('GET', '/readyz')).status === 503);
  const readiness = await api('GET', '/readyz');
  check(
    'Redis down → /readyz 503 degraded, naming redis',
    degraded && readiness.json?.status === 'degraded' && readiness.json?.checks?.redis === 'down',
    JSON.stringify(readiness.json?.checks),
  );
  check('…but /healthz stays 200', (await api('GET', '/healthz')).status === 200);
  await sleep(12_000); // more than one healthcheck interval
  const ps = compose('ps --format "{{.Name}} {{.Status}}"');
  check(
    '…and Docker keeps both backends healthy: liveness, not readiness, decides restarts',
    /backend-1 .*\(healthy\)/.test(ps) && /backend-2 .*\(healthy\)/.test(ps),
  );
  compose('start redis');
  check(
    'Redis back → /readyz 200 again',
    await until(async () => (await api('GET', '/readyz')).status === 200, 30_000),
  );
}

async function floodControl() {
  const burst = await Promise.all(
    Array.from({ length: 150 }, () => api('GET', '/api/documents', { token })),
  );
  const refused = burst.filter((response) => response.status === 429);
  check(
    'a 150-request burst from one IP is trimmed by Nginx (30 r/s, burst 60)',
    refused.length > 0 && refused.length < 150,
    `${refused.length} refused`,
  );
  check(
    '…answered in the JSON envelope with Retry-After',
    refused.every(
      (r) => r.json?.error?.code === 'RATE_LIMITED' && r.headers.get('retry-after') === '1',
    ),
  );
}

function logHygiene(since) {
  const nginx = logsSince('nginx', since);
  const access = nginx.split(/\r?\n/).filter((line) => line.startsWith('{'));
  check(
    'Nginx access logs never contain WebSocket tickets',
    access.some((line) => line.includes('"/ws"')) &&
      !access.some((line) => line.includes('ticket=')),
  );
  check('health probes are not access-logged', !/"uri":"\/(healthz|readyz)"/.test(nginx));
  const requests = replicaLogs(1, since)
    .split('\n')
    .filter((line) => line.includes('request completed'));
  check(
    'backend request logs are one compact line each (no headers)',
    requests.length > 0 &&
      requests.every((line) => !line.includes('"headers"') && line.length < 400),
  );
}

const started = new Date().toISOString();
await gracefulShutdown();
await failover();
await redisOutage();
await floodControl();
logHygiene(started);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
