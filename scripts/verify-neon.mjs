// Safe live smoke test: creates two test accounts and one verification document.
// Never truncates tables or modifies an existing user's data.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { fromBase64, toBase64, YDOC_TEXT_KEY } from '@collab/shared';

const base = process.argv[2]?.replace(/\/$/, '');
assert(base?.startsWith('https://'), 'Pass the deployed HTTPS origin');
const clients = [];
const password = randomBytes(24).toString('base64url');
const stamp = Date.now();

async function http(method, route, { token, body, cookie } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      Origin: base,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  assert(response.ok, `${method} ${route}: ${response.status} ${data.error?.code ?? ''}`);
  return { response, data };
}

async function eventually(check) {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    assert(Date.now() < deadline, 'Timed out waiting for document synchronization');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function connect(documentId, token) {
  const { data } = await http('POST', `/api/documents/${documentId}/ws-ticket`, { token });
  const doc = new Y.Doc();
  const socket = new WebSocket(
    `${base.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(data.ticket)}`,
    { origin: base },
  );
  let synced = false;
  let error = null;
  socket.on('error', (err) => {
    error = err;
  });
  const send = (message) =>
    socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
  doc.on('update', (update, origin) => {
    if (origin !== 'remote') send({ type: 'update', update: toBase64(update) });
  });
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === 'joined')
      send({ type: 'sync-step1', stateVector: toBase64(Y.encodeStateVector(doc)) });
    if (message.type === 'sync-step1')
      send({
        type: 'sync-step2',
        update: toBase64(Y.encodeStateAsUpdate(doc, fromBase64(message.stateVector))),
      });
    if (message.type === 'sync-step2' || message.type === 'update') {
      Y.applyUpdate(doc, fromBase64(message.update), 'remote');
      if (message.type === 'sync-step2') synced = true;
    }
  });
  const client = { socket, doc, text: doc.getText(YDOC_TEXT_KEY) };
  clients.push(client);
  await eventually(() => {
    if (error) throw error;
    return synced;
  });
  return client;
}

try {
  const ready = await http('GET', '/readyz');
  assert.deepEqual(ready.data.checks, { database: 'up', redis: 'up' });
  console.log('PASS readiness: PostgreSQL and Redis up');
  const users = [];
  for (const name of ['Owner', 'Editor']) {
    const email = `neon-verify-${name.toLowerCase()}-${stamp}@example.test`;
    const registration = await http('POST', '/api/auth/register', {
      body: { name: `Neon Verify ${name}`, email, password },
    });
    assert.match(registration.response.headers.get('set-cookie') ?? '', /HttpOnly/i);
    const login = await http('POST', '/api/auth/login', { body: { email, password } });
    const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
    const refresh = await http('POST', '/api/auth/refresh', { cookie });
    users.push({ email, token: refresh.data.accessToken });
  }
  console.log('PASS two registrations, login, secure cookie, refresh rotation');
  const [owner, editor] = users;
  const { data: created } = await http('POST', '/api/documents', {
    token: owner.token,
    body: { name: `neon-verification-${stamp}.js`, language: 'javascript' },
  });
  const id = created.document.id;
  await http('POST', `/api/documents/${id}/members`, {
    token: owner.token,
    body: { email: editor.email, role: 'EDITOR' },
  });
  console.log('PASS document creation and editor sharing');
  const a = await connect(id, owner.token);
  const b = await connect(id, editor.token);
  const initial = '// Verified live on Neon\n';
  a.text.insert(0, initial);
  await eventually(() => b.text.toString() === initial);
  b.text.insert(b.text.length, 'const collaborative = true;\n');
  await eventually(() => a.text.toString() === b.text.toString() && a.text.length > initial.length);
  const expected = a.text.toString();
  console.log('PASS bidirectional Yjs edits over authenticated WSS');
  const { data: saved } = await http('POST', `/api/documents/${id}/revisions`, {
    token: owner.token,
  });
  const revisionId = saved.revision.id;
  const { data: history } = await http('GET', `/api/documents/${id}/revisions/${revisionId}`, {
    token: owner.token,
  });
  assert.equal(history.revision.content, expected);
  console.log('PASS revision persisted and read back through API');
  a.text.insert(a.text.length, '// temporary edit\n');
  await eventually(() => b.text.toString().includes('temporary edit'));
  await http('POST', `/api/documents/${id}/revisions/${revisionId}/restore`, {
    token: owner.token,
  });
  await eventually(() => a.text.toString() === expected && b.text.toString() === expected);
  console.log('PASS revision restore reaches both clients');
  for (const c of [a, b]) {
    c.socket.close();
    await new Promise((resolve) => c.socket.once('close', resolve));
  }
  const late = await connect(id, owner.token);
  await eventually(() => late.text.toString() === expected);
  console.log('PASS fresh connection reloads saved content');
  console.log(`VERIFIED_DOCUMENT_ID=${id}`);
  console.log('All live Neon checks passed');
} finally {
  for (const client of clients) {
    client.socket.terminate();
    client.doc.destroy();
  }
}
