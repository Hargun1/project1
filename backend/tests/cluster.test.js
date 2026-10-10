import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { encodeAwarenessUpdate } from 'y-protocols/awareness';
import { toBase64, WS_CLOSE_CODES, YDOC_TEXT_KEY } from '@collab/shared';
import { connectClient, eventually } from './helpers/yjs-test-client.js';
import { createMemoryNetwork } from './helpers/memory-bus.js';
import { fakeStore } from './helpers/fake-document-store.js';

/**
 * Phase 8: two backend instances, each with its own WebSocket server and
 * collaboration hub, linked only by a Pub/Sub bus — the in-memory stand-in for
 * Redis, which can also simulate an outage. Clients of instance A and of
 * instance B must still edit one document together (§36, §37).
 */

const DOC_ID = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const db = vi.hoisted(() => ({
  tickets: new Map(),
  /** Users whose membership was removed; everyone else is an EDITOR (Phase 10). */
  removed: new Set(),
}));

vi.mock('../src/websocket/ticket.service.js', () => ({
  issueTicket: vi.fn(),
  consumeTicket: vi.fn(async (ticket) => {
    const data = db.tickets.get(ticket) ?? null;
    db.tickets.delete(ticket);
    return data;
  }),
}));

vi.mock('../src/repositories/user.repository.js', () => ({
  findById: vi.fn(async (id) => ({ id, name: id === ALICE ? 'Alice' : 'Bob', email: 'x@x.test' })),
}));

vi.mock('../src/repositories/document.repository.js', () => ({
  getDocumentWithRole: vi.fn(async (documentId, userId) =>
    documentId === DOC_ID
      ? { document: { id: documentId }, role: db.removed.has(userId) ? null : 'EDITOR' }
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
const { documentChannel } = await import('../src/redis/bus-messages.js');

const network = createMemoryNetwork();
const instances = {};
const clients = [];
let ticketSeq = 0;

async function startInstance(instanceId) {
  const bus = network.createBus();
  const hub = createCollaborationHub({ bus, instanceId });
  const server = createServer();
  const wss = attachWebSocketServer(server, { hub });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { hub, bus, server, wss, url: `ws://127.0.0.1:${server.address().port}/ws` };
}

function connect(instance, userId, ydoc, awareness) {
  const ticket = `t-${(ticketSeq += 1)}`;
  db.tickets.set(ticket, { userId, documentId: DOC_ID });
  const client = connectClient(instances[instance].url, ticket, ydoc, awareness);
  clients.push(client);
  return client;
}

const textOf = (state) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText(YDOC_TEXT_KEY).toString();
};

beforeAll(async () => {
  instances.A = await startInstance('instance-A');
  instances.B = await startInstance('instance-B');
});

afterAll(async () => {
  for (const { wss, server } of Object.values(instances)) {
    await closeWebSocketServer(wss);
    await new Promise((resolve) => server.close(resolve));
  }
});

beforeEach(() => {
  db.removed.clear();
  network.setUp(true);
  fakeStore.reset();
});

afterEach(async () => {
  network.setUp(true);
  fakeStore.frozen = false;
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await eventually(
    () => instances.A.hub.getSessionCount() === 0 && instances.B.hub.getSessionCount() === 0,
  );
});

describe('two backend instances', () => {
  it('relays edits between clients on different instances, and they converge', async () => {
    const alice = connect('A', ALICE);
    const bob = connect('B', BOB);
    await Promise.all([alice.synced(), bob.synced()]);

    alice.text.insert(0, 'from A\n');
    bob.text.insert(0, 'from B\n');

    await eventually(() => alice.text.length === 14 && bob.text.length === 14);
    expect(alice.text.toString()).toBe(bob.text.toString());
  });

  it('relays presence across instances and removes it when the socket closes', async () => {
    const alice = connect('A', ALICE);
    const bob = connect('B', BOB);
    await Promise.all([alice.synced(), bob.synced()]);
    await eventually(() => alice.peers().join() === 'Bob' && bob.peers().join() === 'Alice');

    await bob.close();
    await eventually(() => alice.peers().length === 0);
  });

  it('brings a newly joining instance up to date even when PostgreSQL lags behind', async () => {
    fakeStore.frozen = true; // nothing A saves reaches the database
    const alice = connect('A', ALICE);
    await alice.synced();
    alice.text.insert(0, 'only in A’s memory');

    // B opens the document for the first time: the database is empty, so the
    // content can only come from A, through the hello handshake on the bus.
    const bob = connect('B', BOB);
    await bob.synced();
    await eventually(() => bob.text.toString() === 'only in A’s memory');
    await eventually(() => bob.peers().join() === 'Alice');
  });
});

describe('Redis outage', () => {
  it('tells clients the cluster is degraded and recovers the edits made meanwhile', async () => {
    const alice = connect('A', ALICE);
    const bob = connect('B', BOB);
    await Promise.all([alice.synced(), bob.synced()]);
    alice.text.insert(0, 'base\n');
    await eventually(() => bob.text.toString() === 'base\n');

    network.setUp(false);
    await alice.waitFor((m) => m.type === 'cluster' && m.state === 'degraded');

    // Each side keeps editing; neither sees the other's change.
    alice.text.insert(5, 'alice offline-from-B\n');
    bob.text.insert(0, 'bob offline-from-A\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alice.text.toString()).not.toContain('bob');
    expect(bob.text.toString()).not.toContain('alice');

    // Redis returns: the hubs resynchronise, without any client reconnecting.
    network.setUp(true);
    await eventually(() => alice.text.toString() === bob.text.toString());
    expect(alice.text.toString()).toContain('alice offline-from-B');
    expect(alice.text.toString()).toContain('bob offline-from-A');
    expect(alice.received.filter((m) => m.type === 'cluster').at(-1).state).toBe('ok');
  });

  it('never lets one instance overwrite the other’s edits in PostgreSQL', async () => {
    const alice = connect('A', ALICE);
    const bob = connect('B', BOB);
    await Promise.all([alice.synced(), bob.synced()]);

    network.setUp(false);
    alice.text.insert(0, 'saved by A\n');
    bob.text.insert(0, 'saved by B\n');

    // Both instances persist their own diverged copy. Merge-on-save keeps both.
    await alice.waitFor((m) => m.type === 'saved');
    await bob.waitFor((m) => m.type === 'saved');
    await eventually(() => {
      const text = fakeStore.state ? textOf(fakeStore.state) : '';
      return text.includes('saved by A') && text.includes('saved by B');
    });
  });
});

describe('cross-instance safety', () => {
  it("refuses a client's attempt to remove a user connected to another instance", async () => {
    const alice = connect('A', ALICE);
    const bob = connect('B', BOB);
    await Promise.all([alice.synced(), bob.synced()]);
    await eventually(() => bob.peers().join() === 'Alice');

    const forged = encodeAwarenessUpdate(bob.awareness, [alice.ydoc.clientID], new Map());
    bob.send({ type: 'awareness', update: toBase64(forged) });

    expect((await bob.waitFor((m) => m.type === 'error')).code).toBe('FORBIDDEN');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bob.peers()).toEqual(['Alice']);
  });

  it('ignores malformed messages on the channel', async () => {
    const alice = connect('A', ALICE);
    const bob = connect('B', BOB);
    await Promise.all([alice.synced(), bob.synced()]);

    const channel = documentChannel(DOC_ID);
    await instances.B.bus.publish(channel, 'not json');
    await instances.B.bus.publish(
      channel,
      JSON.stringify({ v: 1, from: 'x', to: null, type: 'update', data: '!!' }),
    );
    await instances.B.bus.publish(
      channel,
      JSON.stringify({
        v: 1,
        from: 'x',
        to: null,
        type: 'update',
        data: toBase64(new Uint8Array([255, 1])),
      }),
    );

    bob.text.insert(0, 'still works');
    await eventually(() => alice.text.toString() === 'still works');
  });
});

describe('revisions across instances', () => {
  it("a version saved on an instance with no clients includes another instance's unsaved edits", async () => {
    fakeStore.frozen = true; // PostgreSQL lags: Bob's edit exists only in B's memory
    const bob = connect('B', BOB);
    await bob.synced();
    bob.text.insert(0, 'typed on B, not yet persisted');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The request lands on instance A, which does not have the document open.
    const { revision } = await instances.A.hub.createRevision(DOC_ID, ALICE);
    expect(textOf(revision.snapshot)).toBe('typed on B, not yet persisted');
  });

  it('a restore executed on one instance reaches clients on the other', async () => {
    const bob = connect('B', BOB);
    await bob.synced();
    bob.text.insert(0, 'original');
    await bob.waitFor((m) => m.type === 'saved'); // the server has it
    await instances.B.hub.createRevision(DOC_ID, BOB);

    const savesBefore = bob.received.filter((m) => m.type === 'saved').length;
    bob.text.delete(0, bob.text.length);
    bob.text.insert(0, 'rewritten');
    // Wait until instance B's *server* has the edit, not just Bob's browser.
    await eventually(() => bob.received.filter((m) => m.type === 'saved').length > savesBefore);

    await instances.A.hub.restoreRevision(DOC_ID, fakeStore.revisions[0], ALICE);
    await eventually(() => bob.text.toString() === 'original');
  });
});

describe('access changes across instances (Phase 10)', () => {
  it('a removal decided on one instance disconnects the user on the other', async () => {
    const alice = connect('A', ALICE);
    const bob = connect('B', BOB);
    await Promise.all([alice.synced(), bob.synced()]);

    // The owner's REST request lands on instance A; Bob's socket is on B.
    db.removed.add(BOB);
    instances.A.hub.notifyAccessChanged(DOC_ID, BOB);

    expect((await bob.closed).code).toBe(WS_CLOSE_CODES.FORBIDDEN);
    alice.send({ type: 'ping' });
    await alice.waitFor((m) => m.type === 'pong');
  });
});
