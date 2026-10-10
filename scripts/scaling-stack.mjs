// Horizontal scaling, demonstrated on the running Docker stack (Phase 14):
//
//   npm run stack:up && npm run stack:scale
//
// 1. Scale out: `docker compose up --scale backend=3`. Nginx discovers the new
//    replica through Docker's DNS with no configuration change, and new
//    sockets are spread over all three.
// 2. Nine collaborators across three instances see one another's edits
//    (Redis Pub/Sub fans every update out to every instance).
// 3. Scale in: back to two replicas. The removed replica shuts down
//    gracefully; its users reconnect to the others and nobody loses an edit.
//
// Only the backend service is touched (--no-deps): scaling must not restart the
// migration job, the databases or Nginx.
//
// Changes the replica count, so it restores the default (2) at the end.

import { execSync, spawn } from 'node:child_process';
import * as Y from 'yjs';
import { fromBase64, toBase64, YDOC_TEXT_KEY } from '@collab/shared';
import { BASE, WS_BASE, report } from './lib/target.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  report(label, ok, detail);
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
const compose = (args) =>
  execSync(`docker compose --profile app ${args}`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

/** Status 0 when no connection could be made, so callers retry like a browser. */
async function api(method, path, { token, body } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Origin: BASE,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { status: 0, json: null };
  }
  return { status: response.status, json: await response.json().catch(() => null) };
}

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

/**
 * The backend addresses Nginx used for a burst of unauthenticated probes
 * (an `upstream` field can list several when a request was retried).
 */
async function routedUpstreams() {
  const since = new Date(Date.now() - 1_000).toISOString();
  for (let i = 0; i < 9; i += 1) await api('GET', '/api/routing-probe');
  const log = compose(`logs nginx --no-log-prefix --since ${since}`);
  return new Set(log.match(/[\d.]+(?=:4000)/g) ?? []);
}

const ipOf = (container) =>
  execSync(
    `docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" ${container}`,
  )
    .toString()
    .trim();

/** Replica name (backend-1, …) that authenticated each socket of `userId`. */
function replicasServing(userId, since) {
  return compose(`logs backend --since ${since}`)
    .split('\n')
    .filter((line) => line.includes('ws connection authenticated') && line.includes(userId))
    .map((line) => line.split('|')[0].trim());
}

const registered = await api('POST', '/api/auth/register', {
  body: {
    name: 'Scale',
    email: `scale-${Date.now()}@example.test`,
    password: 'correct-horse-battery',
  },
});
if (registered.status !== 201) {
  console.error(`Cannot register through ${BASE} (${registered.status}). Is the stack up?`);
  process.exit(1);
}
const token = registered.json.accessToken;
const userId = registered.json.user.id;
const doc = (
  await api('POST', '/api/documents', { token, body: { name: 'scale.js', language: 'javascript' } })
).json.document;
const ticket = async () =>
  (await api('POST', `/api/documents/${doc.id}/ws-ticket`, { token })).json?.ticket;

/** Connect, retrying like the browser client when a request hits a replica in transition. */
async function connectLikeABrowser() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const value = await ticket();
    if (value) {
      const client = connect(value);
      await until(() => client.synced() || client.closeCode !== null, 10_000);
      if (client.synced()) return client;
      client.close();
    }
    await sleep(1_000);
  }
  throw new Error('could not connect');
}

try {
  // ── 1. Scale out ───────────────────────────────────────────────────────────
  compose('up -d --no-build --no-deps --wait --scale backend=3 backend');
  const running = compose('ps --status running --format "{{.Name}}"')
    .split('\n')
    .filter((name) => name.includes('backend')).length;
  check('docker compose --scale backend=3 starts a third healthy replica', running === 3);
  check(
    'Nginx routes to all three without any configuration change',
    await until(async () => (await routedUpstreams()).size >= 3, 30_000),
  );

  const since = new Date().toISOString();
  const clients = [];
  for (let i = 0; i < 9; i += 1) clients.push(await connectLikeABrowser());
  const replicas = replicasServing(userId, since);
  const perReplica = Object.fromEntries(
    [...new Set(replicas)].sort().map((name) => [name, replicas.filter((r) => r === name).length]),
  );
  check(
    'least_conn spreads nine collaborators over the three instances',
    Object.keys(perReplica).length === 3,
    JSON.stringify(perReplica),
  );

  // ── 2. Edits reach everyone, on every instance ─────────────────────────────
  clients[0].text.insert(0, 'three instances;');
  clients[8].text.insert(0, 'one document;');
  check(
    'every edit reaches all nine clients across the three instances',
    await until(() => {
      const first = clients[0].text.toString();
      return (
        first.length === 'three instances;one document;'.length &&
        clients.every((client) => client.text.toString() === first)
      );
    }),
  );

  // ── 3. Scale in ────────────────────────────────────────────────────────────
  // Compose removes the highest-numbered replica, and its logs with it, so
  // follow them while it shuts down.
  const removed = 'collab-editor-backend-3';
  const removedIp = ipOf(removed);
  let removedLogs = '';
  const follower = spawn('docker', ['logs', '-f', removed]);
  follower.stdout.on('data', (chunk) => (removedLogs += chunk));
  follower.stderr.on('data', (chunk) => (removedLogs += chunk));

  compose('up -d --no-build --no-deps --wait --scale backend=2 backend');
  await until(() => /"msg":"WebSocket server closed"/.test(removedLogs), 20_000);
  follower.kill();
  await until(() => clients.some((client) => client.closeCode !== null), 10_000);
  const dropped = clients.filter((client) => client.closeCode !== null);
  const kept = clients.filter((client) => client.closeCode === null);
  check(
    'scaling in to two closes only the removed replica’s sockets, with SERVER_SHUTDOWN',
    dropped.length > 0 && kept.length > 0 && dropped.every((client) => client.closeCode === 4008),
    `${dropped.length} of 9 closed`,
  );
  check(
    'the removed replica shut down gracefully (SIGTERM, sockets closed, no forced exit)',
    /"signal":"SIGTERM"/.test(removedLogs) &&
      /WebSocket server closed/.test(removedLogs) &&
      !/forcing exit/.test(removedLogs),
  );

  const back = [];
  for (let i = 0; i < dropped.length; i += 1) back.push(await connectLikeABrowser());
  check(
    'its users reconnect to the remaining instances with the document intact',
    back.every((client) => client.text.toString() === clients[0].text.toString()),
  );
  kept[0].text.insert(kept[0].text.length, ' after scale-in;');
  check(
    'editing continues for everyone after scaling in',
    await until(() =>
      [...kept, ...back].every((client) => client.text.toString().endsWith(' after scale-in;')),
    ),
  );
  // least_conn favours whichever replica holds fewer of the open sockets, so the
  // probes may all land on one; what matters is that none reaches the removed one.
  check(
    'Nginx stops routing to the removed replica',
    await until(async () => !(await routedUpstreams()).has(removedIp), 30_000),
    removedIp,
  );
  for (const client of [...clients, ...back]) client.close();
} catch (err) {
  // A step that throws (a compose command, a connection that never syncs) is a failure too.
  check(
    'the run finished without an unexpected error',
    false,
    String(err.message).split(/\r?\n/).slice(0, 3).join(' | '),
  );
} finally {
  compose('up -d --no-build --no-deps --wait --scale backend=2 backend');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
