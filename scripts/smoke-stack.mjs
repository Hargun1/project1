// Smoke test for the Docker stack (Phase 12), run from the host against Nginx
// only — exactly the path a browser takes:
//
//   npm run stack:up && npm run stack:smoke
//   node scripts/smoke-stack.mjs https://localhost:8443
//
// Checks the static frontend and its headers, health routing, the auth flow,
// and real-time collaboration between four WebSocket clients. Nginx's
// least_conn spreads them over both backend instances, so the edit has to
// cross Redis Pub/Sub to reach all of them. Exits non-zero on any failure.
//
// Uses the root node_modules (yjs) and the shared workspace, so run `npm ci`
// first. Node 22+ provides fetch and WebSocket globally.

import * as Y from 'yjs';
import { fromBase64, toBase64, YDOC_TEXT_KEY } from '@collab/shared';
import { BASE, IS_LOCAL, WS_BASE } from './lib/target.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate, timeoutMs = 10_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(50);
  }
  return true;
}

async function http(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      // What a browser on this origin sends; the CSRF check must accept it.
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
    // not JSON (HTML)
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** A minimal collaboration client: the same sync protocol as the frontend. */
function connect(ticket) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(`${WS_BASE}/ws?ticket=${encodeURIComponent(ticket)}`);
  const messages = [];
  const send = (message) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));

  ydoc.on('update', (update, origin) => {
    if (origin !== 'remote') send({ type: 'update', update: toBase64(update) });
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
    ws,
    text: ydoc.getText(YDOC_TEXT_KEY),
    synced: () => messages.some((m) => m.type === 'sync-step2'),
    close: () => ws.close(),
  };
}

// ── Nginx itself and health routing ────────────────────────────────────────
check('Nginx answers its own liveness probe', (await http('GET', '/nginx-health')).status === 200);

const health = await http('GET', '/healthz');
check(
  '/healthz is proxied to a backend instance',
  health.status === 200 && health.json?.status === 'ok',
);

const readiness = await http('GET', '/readyz');
check(
  '/readyz reports the instance ready (PostgreSQL and Redis up)',
  readiness.status === 200 && readiness.json?.status === 'ready',
  JSON.stringify(readiness.json?.checks),
);

// ── HTTPS ──────────────────────────────────────────────────────────────────
// The plain-HTTP address of the same stack: :8080 locally (next to :8443),
// the default port 80 for a real deployment.
const plain = await fetch(
  `${BASE.replace(/^https:/, 'http:').replace(':8443', ':8080')}/editor/x?y=1`,
  {
    redirect: 'manual',
  },
);
check(
  'plain HTTP redirects to HTTPS, keeping the path',
  plain.status === 301 && plain.headers.get('location') === `${BASE}/editor/x?y=1`,
  `${plain.status} → ${plain.headers.get('location')}`,
);

// ── Static frontend ────────────────────────────────────────────────────────
const index = await http('GET', '/');
const csp = index.headers.get('content-security-policy') ?? '';
check(
  'the built frontend is served at /',
  index.status === 200 && index.text.includes('<div id="root">'),
);
check(
  'the page carries a strict Content-Security-Policy',
  csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"),
);
check(
  'the page carries the other security headers and no server version',
  index.headers.get('x-content-type-options') === 'nosniff' &&
    index.headers.get('x-frame-options') === 'DENY' &&
    !/\d/.test(index.headers.get('server') ?? ''),
  `server: ${index.headers.get('server')}`,
);
check('index.html is revalidated on every load', index.headers.get('cache-control') === 'no-cache');
const hsts = index.headers.get('strict-transport-security');
check(
  IS_LOCAL
    ? 'no HSTS for localhost (it would force HTTPS on every local project)'
    : 'HSTS tells browsers to use HTTPS only',
  IS_LOCAL ? hsts === null : /max-age=\d+/.test(hsts ?? ''),
  `${hsts}`,
);

const deepLink = await http('GET', '/documents/00000000-0000-4000-8000-000000000000');
check(
  'client-side routes fall back to index.html (SPA)',
  deepLink.status === 200 && deepLink.text.includes('<div id="root">'),
);

const assetPath = index.text.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
const asset = assetPath ? await http('GET', assetPath) : null;
check(
  'hashed assets are cached for a year',
  asset?.status === 200 && (asset.headers.get('cache-control') ?? '').includes('max-age=31536000'),
  assetPath,
);

// ── API through the proxy ──────────────────────────────────────────────────
const stamp = Date.now();
const register = await http('POST', '/api/auth/register', {
  body: {
    name: 'Smoke Test',
    email: `smoke-${stamp}@example.test`,
    password: 'smoke-test-password',
  },
});
const token = register.json?.accessToken;
const setCookie = register.headers.get('set-cookie') ?? '';
check('registration works through Nginx', register.status === 201 && typeof token === 'string');
check(
  'the refresh cookie is HttpOnly, scoped to /api/auth and Secure (production mode)',
  /HttpOnly/i.test(setCookie) && /Path=\/api\/auth/i.test(setCookie) && /Secure/i.test(setCookie),
);
check(
  "the backend reuses Nginx's request id (one id across both logs)",
  /^[0-9a-f]{32}$/.test(register.headers.get('x-request-id') ?? ''),
  register.headers.get('x-request-id'),
);
check('API responses are not cacheable', register.headers.get('cache-control') === 'no-store');

const missing = await http('GET', '/api/does-not-exist', { token });
check(
  'API errors keep the JSON envelope through the proxy',
  missing.status === 404 && missing.json?.error?.code === 'NOT_FOUND',
);

const created = await http('POST', '/api/documents', {
  token,
  body: { name: 'smoke.js', language: 'javascript' },
});
const documentId = created.json?.document?.id;
check('a document can be created', created.status === 201 && typeof documentId === 'string');

// ── Collaboration across instances ─────────────────────────────────────────
const ticket = async () =>
  (await http('POST', `/api/documents/${documentId}/ws-ticket`, { token })).json?.ticket;

const clients = [];
for (let i = 0; i < 4; i += 1) clients.push(connect(await ticket()));
check(
  'four WebSocket clients upgrade through Nginx and sync',
  await eventually(() => clients.every((client) => client.synced())),
);

clients[0].text.insert(0, 'console.log("hello from the stack");');
check(
  'an edit reaches every client, across both backend instances',
  await eventually(() =>
    clients.every((client) => client.text.toString() === 'console.log("hello from the stack");'),
  ),
  clients.map((client) => client.text.length).join(','),
);

for (const client of clients) client.close();
await sleep(1_000); // the last disconnect saves the document

const late = connect(await ticket());
check(
  'a client joining later receives the document',
  await eventually(() => late.text.toString() === 'console.log("hello from the stack");'),
);
late.close();
await sleep(200);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
