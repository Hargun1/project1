import { describe, expect, it } from 'vitest';
import { WS_CLOSE_CODES } from '@collab/shared';
import {
  api,
  connectClient,
  createDocument,
  eventually,
  issueTicket,
  openClient,
  prisma,
  registerUser,
  share,
  startInstance,
  storedText,
  until,
  useIntegrationStack,
} from './stack.js';

/**
 * Real-time collaboration through the whole stack: two backend instances, real
 * WebSocket servers, tickets in Redis, edits across Redis Pub/Sub, state in
 * PostgreSQL. Spec §38: two clients, concurrent updates, reconnection,
 * cross-instance synchronisation; a viewer cannot edit; oversized documents
 * are rejected.
 */

useIntegrationStack();

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

/** Two instances, Ada (owner) and Bob (role on the document), one document. */
async function twoInstances(bobRole = 'EDITOR') {
  const a = await startInstance('a');
  const b = await startInstance('b');
  const ada = await registerUser(a, 'Ada');
  const bob = await registerUser(a, 'Bob');
  const doc = await createDocument(a, ada);
  await share(a, ada, doc.id, bob, bobRole);
  return { a, b, ada, bob, doc };
}

describe('tickets', () => {
  it('admit exactly one WebSocket connection', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const doc = await createDocument(a, ada);
    const ticket = await issueTicket(a, ada, doc.id);

    const first = connectClient(a.wsUrl, ticket);
    await first.synced();
    const replay = connectClient(a.wsUrl, ticket);
    expect((await replay.closed).code).toBe(WS_CLOSE_CODES.AUTH_FAILED);
    await first.close();
  });

  it('admit exactly one of two handshakes racing with the same ticket (GETDEL is atomic)', async () => {
    const a = await startInstance('a');
    const b = await startInstance('b');
    const ada = await registerUser(a, 'Ada');
    const doc = await createDocument(a, ada);

    for (let round = 0; round < 5; round += 1) {
      const ticket = await issueTicket(a, ada, doc.id);
      const racers = [connectClient(a.wsUrl, ticket), connectClient(b.wsUrl, ticket)];
      const outcomes = await Promise.all(
        racers.map((client) =>
          Promise.race([
            client.synced().then(() => 'admitted'),
            client.closed.then((info) => info.code),
          ]),
        ),
      );
      expect(outcomes.sort()).toEqual([WS_CLOSE_CODES.AUTH_FAILED, 'admitted']);
      await Promise.all(racers.map((client) => client.close()));
    }
  });

  it('are refused on an instance after they were used on another', async () => {
    const a = await startInstance('a');
    const b = await startInstance('b');
    const ada = await registerUser(a, 'Ada');
    const doc = await createDocument(a, ada);
    const ticket = await issueTicket(a, ada, doc.id);

    const onB = connectClient(b.wsUrl, ticket);
    await onB.synced();
    const onA = connectClient(a.wsUrl, ticket);
    expect((await onA.closed).code).toBe(WS_CLOSE_CODES.AUTH_FAILED);
    await onB.close();
  });
});

describe('editing across instances', () => {
  it('converges when two users on different instances type at the same time, and PostgreSQL agrees', async () => {
    const { a, b, ada, bob, doc } = await twoInstances();
    const adaClient = await openClient(a, ada, doc.id);
    const bobClient = await openClient(b, bob, doc.id);
    await Promise.all([adaClient.synced(), bobClient.synced()]);

    // Interleaved typing, each at the start of the document, with no waiting
    // for the other side: the classic conflict a lock-based editor must serialise.
    for (let i = 0; i < 40; i += 1) {
      adaClient.text.insert(0, 'a');
      bobClient.text.insert(0, 'b');
      if (i % 10 === 0) await settle(5);
    }

    await eventually(
      () => adaClient.text.length === 80 && adaClient.text.toString() === bobClient.text.toString(),
      5_000,
    );
    const merged = adaClient.text.toString();
    expect(merged.replace(/b/g, '')).toHaveLength(40);
    expect(merged.replace(/a/g, '')).toHaveLength(40);

    // The last client leaving saves the document.
    await Promise.all([adaClient.close(), bobClient.close()]);
    await until(async () => (await storedText(doc.id)) === merged);
  });

  it('merges edits made offline when the client reconnects to the other instance', async () => {
    const { a, b, ada, bob, doc } = await twoInstances();
    const adaClient = await openClient(a, ada, doc.id);
    const bobClient = await openClient(b, bob, doc.id);
    await Promise.all([adaClient.synced(), bobClient.synced()]);
    adaClient.text.insert(0, 'shared;');
    await eventually(() => bobClient.text.toString() === 'shared;');

    await bobClient.disconnect(); // a network blip
    bobClient.text.insert(bobClient.text.length, ' offline-bob;');
    adaClient.text.insert(adaClient.text.length, ' online-ada;');

    // Back through the load balancer, which happens to pick the other instance.
    const back = await openClient(a, bob, doc.id, bobClient);
    await back.synced();
    await eventually(
      () =>
        adaClient.text.toString() === back.text.toString() &&
        back.text.toString().includes('offline-bob') &&
        back.text.toString().includes('online-ada'),
      5_000,
    );
  });

  it('survives a full restart: a new instance serves the stored document', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const doc = await createDocument(a, ada);
    const client = await openClient(a, ada, doc.id);
    await client.synced();
    client.text.insert(0, 'persist me');
    await settle(100); // well inside the save debounce: only shutdown can save it

    await a.stop(); // the graceful-shutdown sequence flushes open documents
    expect(await storedText(doc.id)).toBe('persist me');

    const c = await startInstance('c');
    const fresh = await openClient(c, ada, doc.id);
    await fresh.synced();
    expect(fresh.text.toString()).toBe('persist me');
  });
});

describe('authorisation on the socket', () => {
  it("refuses a viewer's edit: it reaches no one and is never stored", async () => {
    const { a, b, ada, bob, doc } = await twoInstances('VIEWER');
    const adaClient = await openClient(a, ada, doc.id);
    const bobClient = await openClient(b, bob, doc.id);
    await Promise.all([adaClient.synced(), bobClient.synced()]);
    adaClient.text.insert(0, 'owner text');
    await eventually(() => bobClient.text.toString() === 'owner text');

    bobClient.text.insert(0, 'viewer was here ');
    const error = await bobClient.waitFor((m) => m.type === 'error');
    expect(error.code).toBe('FORBIDDEN');

    await settle();
    expect(adaClient.text.toString()).toBe('owner text');
    await adaClient.close();
    await bobClient.close();
    await until(async () => (await storedText(doc.id)) === 'owner text');
  });

  it('closes a removed member’s socket on another instance (4003), and everyone’s on delete (4004)', async () => {
    const { a, b, ada, bob, doc } = await twoInstances();
    const bobClient = await openClient(b, bob, doc.id);
    await bobClient.synced();

    // The removal happens through instance A; Bob is connected to B.
    expect((await api(a, ada).delete(`/api/documents/${doc.id}/members/${bob.id}`)).status).toBe(
      204,
    );
    expect((await bobClient.closed).code).toBe(WS_CLOSE_CODES.FORBIDDEN);

    const adaOnB = await openClient(b, ada, doc.id);
    await adaOnB.synced();
    expect((await api(a, ada).delete(`/api/documents/${doc.id}`)).status).toBe(204);
    expect((await adaOnB.closed).code).toBe(WS_CLOSE_CODES.DOCUMENT_NOT_FOUND);
  });

  it('refuses an update over the size cap; the stored document is unchanged', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const doc = await createDocument(a, ada);
    const client = await openClient(a, ada, doc.id);
    await client.synced();
    client.text.insert(0, 'small');
    await settle(200);

    client.text.insert(0, 'x'.repeat(70_000)); // MAX_DOCUMENT_SIZE_BYTES is 64 KB in tests
    const error = await client.waitFor((m) => m.type === 'error');
    expect(error.code).toBe('DOCUMENT_TOO_LARGE');

    await client.close();
    await until(async () => (await storedText(doc.id)) === 'small');
  });
});

describe('revisions', () => {
  it('saves a version and restores it; a client on the other instance sees the restore live', async () => {
    const { a, b, ada, bob, doc } = await twoInstances();
    const adaClient = await openClient(a, ada, doc.id);
    const bobClient = await openClient(b, bob, doc.id);
    await Promise.all([adaClient.synced(), bobClient.synced()]);

    adaClient.text.insert(0, 'version one');
    await eventually(() => bobClient.text.toString() === 'version one');
    const saved = await api(a, ada).post(`/api/documents/${doc.id}/revisions`);
    expect(saved.status).toBe(201);
    expect(saved.body.revision).toMatchObject({ revisionNumber: 1, kind: 'MANUAL' });

    adaClient.text.delete(0, adaClient.text.length);
    adaClient.text.insert(0, 'version two, worse');
    await eventually(() => bobClient.text.toString() === 'version two, worse');

    const restoreUrl = `/api/documents/${doc.id}/revisions/${saved.body.revision.id}/restore`;
    // Editors may save versions but not restore them (OWNER only).
    expect((await api(b, bob).post(restoreUrl)).status).toBe(403);

    // Ada restores through instance B; Bob watches on B, Ada's own socket is on A.
    const restored = await api(b, ada).post(restoreUrl);
    expect(restored.status).toBe(201);
    expect(restored.body.revision).toMatchObject({ kind: 'RESTORE', restoredFromNumber: 1 });
    await eventually(() => adaClient.text.toString() === 'version one', 5_000);
    await eventually(() => bobClient.text.toString() === 'version one', 5_000);

    const rows = await prisma.documentRevision.findMany({
      where: { documentId: doc.id },
      orderBy: { revisionNumber: 'asc' },
    });
    expect(rows.map((r) => [r.revisionNumber, r.kind])).toEqual([
      [1, 'MANUAL'],
      [2, 'RESTORE'],
    ]);
  });
});
