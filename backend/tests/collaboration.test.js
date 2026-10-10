import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { encodeAwarenessUpdate } from 'y-protocols/awareness';
import { colorForUser, toBase64, WS_CLOSE_CODES } from '@collab/shared';
import { connectClient, eventually } from './helpers/yjs-test-client.js';
import { fakeStore } from './helpers/fake-document-store.js';

/**
 * Phase 6 collaboration tests, end to end through the real WebSocket server,
 * connection handler and collaboration service. Only the edges are faked:
 * tickets (Redis) and the repositories (PostgreSQL).
 */

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIEWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STRANGER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EDITOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const db = vi.hoisted(() => ({
  tickets: new Map(),
  roles: new Map(),
  documentExists: true,
}));

vi.mock('../src/websocket/ticket.service.js', () => ({
  issueTicket: vi.fn(),
  consumeTicket: vi.fn(async (ticket) => {
    const data = db.tickets.get(ticket) ?? null;
    db.tickets.delete(ticket); // single use, like GETDEL
    return data;
  }),
}));

vi.mock('../src/repositories/user.repository.js', () => ({
  findById: vi.fn(async (id) => ({ id, name: `user-${id.slice(0, 4)}`, email: `${id}@x.test` })),
}));

vi.mock('../src/repositories/document.repository.js', () => ({
  getDocumentWithRole: vi.fn(async (documentId, userId) =>
    db.documentExists && documentId === DOC_ID
      ? { document: { id: documentId }, role: db.roles.get(userId) ?? null }
      : null,
  ),
  getDocumentState: vi.fn(async () => {
    const { fakeStore: store } = await import('./helpers/fake-document-store.js');
    return store.state;
  }),
  withLockedDocumentState: vi.fn(async (id, fn) => {
    const { fakeStore: store } = await import('./helpers/fake-document-store.js');
    return store.withLockedDocumentState(id, fn);
  }),
}));

const { attachWebSocketServer, closeWebSocketServer } =
  await import('../src/websocket/ws-server.js');
const { createCollaborationHub } = await import('../src/services/collaboration.service.js');

// Single instance: no bus. Cross-instance behaviour is in cluster.test.js.
const hub = createCollaborationHub();
const getSessionCount = () => hub.getSessionCount();

let server;
let wss;
let wsUrl;
let ticketSeq = 0;
const clients = [];

function ticketFor(userId) {
  const ticket = `ticket-${(ticketSeq += 1)}`;
  db.tickets.set(ticket, { userId, documentId: DOC_ID });
  return ticket;
}

function connect(userId, ydoc, awareness) {
  const client = connectClient(wsUrl, ticketFor(userId), ydoc, awareness);
  clients.push(client);
  return client;
}

beforeAll(async () => {
  server = createServer();
  // A short periodic access re-check, so the safety-net test runs quickly.
  wss = attachWebSocketServer(server, { hub, accessRecheckMs: 100 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
});

afterAll(async () => {
  await closeWebSocketServer(wss);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  db.tickets.clear();
  db.roles = new Map([
    [OWNER, 'OWNER'],
    [VIEWER, 'VIEWER'],
    [EDITOR, 'EDITOR'],
  ]);
  db.documentExists = true;
  fakeStore.reset();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  // Sessions flush and evict once their last client leaves.
  await eventually(() => getSessionCount() === 0);
});

describe('collaborative editing', () => {
  it('converges when two clients edit the same spot concurrently', async () => {
    const alice = connect(OWNER);
    const bob = connect(OWNER);
    await Promise.all([alice.synced(), bob.synced()]);

    // Both insert at offset 0 before either has seen the other's edit.
    alice.text.insert(0, 'alice ');
    bob.text.insert(0, 'bob ');

    await eventually(() => alice.text.toString() === bob.text.toString());
    const merged = alice.text.toString();
    expect(merged).toContain('alice ');
    expect(merged).toContain('bob ');
    expect(merged).toHaveLength('alice bob '.length);
  });

  it('sends a late joiner the full current state', async () => {
    const alice = connect(OWNER);
    await alice.synced();
    alice.text.insert(0, 'function main() {}');

    const carol = connect(OWNER);
    await carol.synced();
    await eventually(() => carol.text.toString() === 'function main() {}');
  });

  it('keeps edits made while disconnected and merges them on reconnect', async () => {
    const alice = connect(OWNER);
    const bob = connect(OWNER);
    await Promise.all([alice.synced(), bob.synced()]);
    alice.text.insert(0, 'shared\n');
    await eventually(() => bob.text.toString() === 'shared\n');

    // Alice drops off the network but keeps her Y.Doc, and keeps typing.
    const aliceDoc = alice.ydoc;
    await alice.disconnect();
    aliceDoc.getText('content').insert(7, 'offline edit\n');
    bob.text.insert(0, '// bob was here\n');

    const aliceAgain = connect(OWNER, aliceDoc, alice.awareness);
    await aliceAgain.synced();

    const expected = '// bob was here\nshared\noffline edit\n';
    await eventually(() => aliceAgain.text.toString() === expected);
    await eventually(() => bob.text.toString() === expected);
  });
});

describe('authorisation on the socket', () => {
  it('lets a viewer read but refuses its updates', async () => {
    const owner = connect(OWNER);
    await owner.synced();
    owner.text.insert(0, 'read me');

    const viewer = connect(VIEWER);
    await viewer.synced();
    await eventually(() => viewer.text.toString() === 'read me');

    // A hand-crafted edit from the viewer's socket.
    viewer.text.insert(0, 'HACKED ');
    const error = await viewer.waitFor((m) => m.type === 'error');
    expect(error.code).toBe('FORBIDDEN');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(owner.text.toString()).toBe('read me');
  });

  it('rejects a reused ticket', async () => {
    const ticket = ticketFor(OWNER);
    const first = connectClient(wsUrl, ticket);
    clients.push(first);
    await first.synced();

    const replay = connectClient(wsUrl, ticket);
    clients.push(replay);
    expect((await replay.closed).code).toBe(WS_CLOSE_CODES.AUTH_FAILED);
  });

  it('rejects a user who is not a member', async () => {
    const stranger = connect(STRANGER);
    expect((await stranger.closed).code).toBe(WS_CLOSE_CODES.FORBIDDEN);
  });

  it('rejects a deleted or missing document', async () => {
    db.documentExists = false;
    const client = connect(OWNER);
    expect((await client.closed).code).toBe(WS_CLOSE_CODES.DOCUMENT_NOT_FOUND);
  });
});

describe('protocol validation', () => {
  it('answers malformed messages with a typed error and keeps the socket open', async () => {
    const client = connect(OWNER);
    await client.synced();

    client.ws.send('not json');
    expect((await client.waitFor((m) => m.type === 'error')).code).toBe('PROTOCOL_ERROR');

    client.send({ type: 'update', update: 'not base64!' });
    await eventually(() => client.received.filter((m) => m.type === 'error').length === 2);

    client.send({ type: 'ping' });
    await client.waitFor((m) => m.type === 'pong');
  });

  it('refuses well-formed base64 that is not a Yjs update', async () => {
    const client = connect(OWNER);
    await client.synced();
    client.send({ type: 'update', update: Buffer.from([255, 255, 255, 255]).toString('base64') });
    expect((await client.waitFor((m) => m.code === 'INVALID_UPDATE')).type).toBe('error');
  });
});

describe('persistence', () => {
  it('saves binary CRDT state after a debounce and reloads it into a new session', async () => {
    const alice = connect(OWNER);
    await alice.synced();
    alice.text.insert(0, 'persist me');

    // `saved` carries the persisted state vector, so the client can tell whether
    // its own edits are durable.
    const saved = await alice.waitFor((m) => m.type === 'saved');
    expect(typeof saved.stateVector).toBe('string');

    const restored = new Y.Doc();
    Y.applyUpdate(restored, fakeStore.state);
    expect(restored.getText('content').toString()).toBe('persist me');

    // Everyone leaves: the session is flushed and evicted, as on a restart.
    await alice.close();
    await eventually(() => getSessionCount() === 0);

    const bob = connect(OWNER);
    await bob.synced();
    await eventually(() => bob.text.toString() === 'persist me');
  });

  it('reports a failed save and keeps the edits until a later save succeeds', async () => {
    const { withLockedDocumentState } = await import('../src/repositories/document.repository.js');
    withLockedDocumentState.mockRejectedValueOnce(new Error('PostgreSQL unavailable'));

    const alice = connect(OWNER);
    await alice.synced();
    alice.text.insert(0, 'do not lose me');

    await alice.waitFor((m) => m.type === 'save-failed');
    expect(fakeStore.state).toBeNull();
    expect(alice.received.some((m) => m.type === 'saved')).toBe(false);

    // The last client leaving forces an immediate save, which now succeeds; only
    // then is the session allowed to leave memory.
    await alice.close();
    await eventually(() => getSessionCount() === 0);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, fakeStore.state);
    expect(restored.getText('content').toString()).toBe('do not lose me');
  });
});

describe('presence', () => {
  const OWNER_NAME = `user-${OWNER.slice(0, 4)}`;
  const EDITOR_NAME = `user-${EDITOR.slice(0, 4)}`;
  const VIEWER_NAME = `user-${VIEWER.slice(0, 4)}`;

  it('shows each collaborator to the others, including late joiners and viewers', async () => {
    const owner = connect(OWNER);
    const editor = connect(EDITOR);
    await Promise.all([owner.synced(), editor.synced()]);
    await eventually(() => owner.peers().join() === EDITOR_NAME);
    await eventually(() => editor.peers().join() === OWNER_NAME);

    // A late joiner sees everyone immediately, without waiting for them to move.
    const viewer = connect(VIEWER);
    await viewer.synced();
    await eventually(() => viewer.peers().join() === [EDITOR_NAME, OWNER_NAME].sort().join());
    await eventually(() => owner.peers().includes(VIEWER_NAME));
  });

  it('relays cursor selections as relative positions', async () => {
    const owner = connect(OWNER);
    const editor = connect(EDITOR);
    await Promise.all([owner.synced(), editor.synced()]);
    owner.text.insert(0, 'hello world');
    await eventually(() => editor.text.toString() === 'hello world');

    owner.awareness.setLocalStateField('selection', {
      anchor: Y.createRelativePositionFromTypeIndex(owner.text, 0),
      head: Y.createRelativePositionFromTypeIndex(owner.text, 5),
    });

    await eventually(() => editor.awareness.getStates().get(owner.ydoc.clientID)?.selection);
    const { selection } = editor.awareness.getStates().get(owner.ydoc.clientID);
    const head = Y.createAbsolutePositionFromRelativePosition(selection.head, editor.ydoc);
    expect(head.index).toBe(5);
  });

  it('removes a collaborator as soon as their socket closes, not after the 30 s timeout', async () => {
    const owner = connect(OWNER);
    const editor = connect(EDITOR);
    await Promise.all([owner.synced(), editor.synced()]);
    await eventually(() => owner.peers().includes(EDITOR_NAME));

    await editor.close();
    await eventually(() => owner.peers().length === 0, 1000);
  });

  it('shows a collaborator again after they reconnect with the same awareness', async () => {
    const owner = connect(OWNER);
    const editor = connect(EDITOR);
    await Promise.all([owner.synced(), editor.synced()]);
    await eventually(() => owner.peers().includes(EDITOR_NAME));

    // Regression guard: awareness ignores updates whose clock is not newer than
    // the last one seen, so removal and re-announcement must not collide.
    const { ydoc, awareness } = editor;
    await editor.disconnect();
    await eventually(() => owner.peers().length === 0);

    const editorAgain = connect(EDITOR, ydoc, awareness);
    await editorAgain.synced();
    await eventually(() => owner.peers().includes(EDITOR_NAME), 1000);
  });

  it('refuses presence that claims another identity', async () => {
    const owner = connect(OWNER);
    const editor = connect(EDITOR);
    await Promise.all([owner.synced(), editor.synced()]);
    await eventually(() => owner.peers().includes(EDITOR_NAME));

    editor.awareness.setLocalState({
      user: { id: EDITOR, name: OWNER_NAME, color: colorForUser(EDITOR) },
    });
    const error = await editor.waitFor((m) => m.type === 'error');
    expect(error.code).toBe('FORBIDDEN');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(owner.peers()).toEqual([EDITOR_NAME]);
  });

  it("refuses an update to another user's awareness entry", async () => {
    const owner = connect(OWNER);
    const editor = connect(EDITOR);
    await Promise.all([owner.synced(), editor.synced()]);
    await eventually(() => editor.peers().includes(OWNER_NAME));

    // Craft an update that would remove the owner's cursor.
    const ownerId = owner.ydoc.clientID;
    const forged = encodeAwarenessUpdate(editor.awareness, [ownerId], new Map());
    editor.send({ type: 'awareness', update: toBase64(forged) });

    expect((await editor.waitFor((m) => m.type === 'error')).code).toBe('FORBIDDEN');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editor.peers()).toEqual([OWNER_NAME]);
  });

  it('refuses awareness state that is not the documented shape', async () => {
    const owner = connect(OWNER);
    await owner.synced();
    owner.awareness.setLocalStateField('script', '<img src=x onerror=alert(1)>');
    expect((await owner.waitFor((m) => m.type === 'error')).code).toBe('PROTOCOL_ERROR');
  });
});

describe('revisions', () => {
  const textOfSnapshot = (snapshot) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);
    return doc.getText('content').toString();
  };

  it('restores an older revision for every connected client and only appends to history', async () => {
    const owner = connect(OWNER);
    const viewer = connect(VIEWER);
    await Promise.all([owner.synced(), viewer.synced()]);

    owner.text.insert(0, 'version one');
    await eventually(() => viewer.text.toString() === 'version one');
    const first = await hub.createRevision(DOC_ID, OWNER);
    expect(first).toMatchObject({ created: true, revision: { revisionNumber: 1, kind: 'MANUAL' } });

    owner.text.delete(0, owner.text.length);
    owner.text.insert(0, 'version two');
    await eventually(() => viewer.text.toString() === 'version two');
    await hub.createRevision(DOC_ID, OWNER);

    const target = fakeStore.revisions[0];
    const restored = await hub.restoreRevision(DOC_ID, target, OWNER);
    expect(restored.revision).toMatchObject({
      revisionNumber: 3,
      kind: 'RESTORE',
      restoredFromNumber: 1,
    });

    // Every client sees it live, as an ordinary update.
    await eventually(() => owner.text.toString() === 'version one');
    await eventually(() => viewer.text.toString() === 'version one');

    // History is append-only: earlier revisions are untouched.
    expect(fakeStore.revisions.map((r) => textOfSnapshot(r.snapshot))).toEqual([
      'version one',
      'version two',
      'version one',
    ]);
  });

  it('answers a repeated "save version" with the existing revision', async () => {
    const owner = connect(OWNER);
    await owner.synced();
    owner.text.insert(0, 'stable');
    await owner.waitFor((m) => m.type === 'saved'); // the server has it

    const first = await hub.createRevision(DOC_ID, OWNER);
    const again = await hub.createRevision(DOC_ID, OWNER);
    expect(again).toEqual({ created: false, revision: first.revision });
    expect(fakeStore.revisions).toHaveLength(1);
  });

  it('creates the very first version even for an empty document', async () => {
    const result = await hub.createRevision(DOC_ID, OWNER);
    expect(result).toMatchObject({
      created: true,
      revision: { revisionNumber: 1, kind: 'MANUAL' },
    });
    await eventually(() => getSessionCount() === 0);
  });

  it('checkpoints automatically: on the first save, and when everyone has left', async () => {
    const owner = connect(OWNER);
    await owner.synced();
    owner.text.insert(0, 'draft');
    await eventually(() => fakeStore.revisions.length === 1);
    expect(fakeStore.revisions[0]).toMatchObject({ kind: 'AUTO', createdById: OWNER });

    // Within the 5-minute interval, further saves do not add revisions…
    owner.text.insert(5, ' and more');
    await owner.waitFor((m) => m.type === 'saved' && fakeStore.saves >= 2);
    expect(fakeStore.revisions).toHaveLength(1);

    // …but the session ends with a checkpoint of the final text.
    await owner.close();
    await eventually(() => fakeStore.revisions.length === 2);
    expect(textOfSnapshot(fakeStore.revisions[1].snapshot)).toBe('draft and more');
  });

  it('can save a version of a document nobody has open', async () => {
    const owner = connect(OWNER);
    await owner.synced();
    owner.text.insert(0, 'closed doc');
    await owner.close();
    await eventually(() => getSessionCount() === 0);

    const result = await hub.createRevision(DOC_ID, OWNER);
    expect(textOfSnapshot(result.revision.snapshot)).toBe('closed doc');
    await eventually(() => getSessionCount() === 0);
  });
});

describe('access changes while connected (Phase 10, §42)', () => {
  it('downgrades a connected editor to viewer live, and refuses their next edit', async () => {
    const owner = connect(OWNER);
    const editor = connect(EDITOR);
    await Promise.all([owner.synced(), editor.synced()]);

    db.roles.set(EDITOR, 'VIEWER');
    hub.notifyAccessChanged(DOC_ID, EDITOR);
    expect((await editor.waitFor((m) => m.type === 'role')).role).toBe('VIEWER');

    editor.text.insert(0, 'too late');
    expect((await editor.waitFor((m) => m.type === 'error')).code).toBe('FORBIDDEN');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(owner.text.toString()).toBe('');
  });

  it('upgrades a connected viewer to editor live', async () => {
    const owner = connect(OWNER);
    const viewer = connect(VIEWER);
    await Promise.all([owner.synced(), viewer.synced()]);

    db.roles.set(VIEWER, 'EDITOR');
    hub.notifyAccessChanged(DOC_ID, VIEWER);
    await viewer.waitFor((m) => m.type === 'role' && m.role === 'EDITOR');

    viewer.text.insert(0, 'now I can edit');
    await eventually(() => owner.text.toString() === 'now I can edit');
  });

  it('disconnects a member who was removed (4003)', async () => {
    const editor = connect(EDITOR);
    await editor.synced();
    db.roles.delete(EDITOR);
    hub.notifyAccessChanged(DOC_ID, EDITOR);
    expect((await editor.closed).code).toBe(WS_CLOSE_CODES.FORBIDDEN);
  });

  it('disconnects everyone when the document is deleted (4004)', async () => {
    const owner = connect(OWNER);
    const viewer = connect(VIEWER);
    await Promise.all([owner.synced(), viewer.synced()]);
    db.documentExists = false;
    hub.notifyAccessChanged(DOC_ID, null);
    expect((await owner.closed).code).toBe(WS_CLOSE_CODES.DOCUMENT_NOT_FOUND);
    expect((await viewer.closed).code).toBe(WS_CLOSE_CODES.DOCUMENT_NOT_FOUND);
  });

  it('only touches the user the change is about', async () => {
    const owner = connect(OWNER);
    const editor = connect(EDITOR);
    await Promise.all([owner.synced(), editor.synced()]);
    db.roles.delete(EDITOR);
    hub.notifyAccessChanged(DOC_ID, EDITOR);
    await editor.closed;
    owner.send({ type: 'ping' });
    await owner.waitFor((m) => m.type === 'pong');
    expect(owner.closeInfo).toBeNull();
  });

  it('still revokes access when no announcement arrives (periodic re-check)', async () => {
    const viewer = connect(VIEWER);
    await viewer.synced();
    db.roles.delete(VIEWER); // changed in the database, nobody told the server
    expect((await viewer.closed).code).toBe(WS_CLOSE_CODES.FORBIDDEN);
  });
});
