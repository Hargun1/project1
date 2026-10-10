import { describe, expect, it } from 'vitest';
import {
  api,
  createDocument,
  eventually,
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
 * Concurrency against the real database (spec Phase 13 "Concurrency"): what
 * happens when instances, writers and requests race. The unit tests use an
 * in-memory store; only PostgreSQL can show that `SELECT … FOR UPDATE`, unique
 * constraints and transactions really serialise the writers.
 */

useIntegrationStack();

describe('merge-on-save (row lock)', () => {
  it('keeps both sides when partitioned instances save the same document at the same moment', async () => {
    // Two instances that cannot see each other (no Pub/Sub): a Redis outage.
    const a = await startInstance('a', { bus: false });
    const b = await startInstance('b', { bus: false });
    const ada = await registerUser(a, 'Ada');
    const bob = await registerUser(a, 'Bob');
    const doc = await createDocument(a, ada);
    await share(a, ada, doc.id, bob, 'EDITOR');

    const adaClient = await openClient(a, ada, doc.id);
    const bobClient = await openClient(b, bob, doc.id);
    await Promise.all([adaClient.synced(), bobClient.synced()]);
    adaClient.text.insert(0, 'from-a;');
    bobClient.text.insert(0, 'from-b;');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Diverged: neither has seen the other's edit.
    expect(adaClient.text.toString()).toBe('from-a;');
    expect(bobClient.text.toString()).toBe('from-b;');

    // Both flush at once. Without the row lock, the second write would replace
    // the first; with it, each save merges into whatever is stored.
    await Promise.all([a.stop(), b.stop()]);

    const stored = await storedText(doc.id);
    expect(stored).toContain('from-a;');
    expect(stored).toContain('from-b;');
    expect(stored).toHaveLength('from-a;from-b;'.length);
  });
});

describe('many writers', () => {
  it('six clients on two instances editing at random positions all converge, and the store agrees', async () => {
    const a = await startInstance('a');
    const b = await startInstance('b');
    const owner = await registerUser(a, 'Owner');
    const doc = await createDocument(a, owner);
    const writers = [owner];
    for (const name of ['W1', 'W2', 'W3', 'W4', 'W5']) {
      const user = await registerUser(a, name);
      await share(a, owner, doc.id, user, 'EDITOR');
      writers.push(user);
    }

    const clients = await Promise.all(
      writers.map((user, i) => openClient(i % 2 ? b : a, user, doc.id)),
    );
    await Promise.all(clients.map((client) => client.synced()));

    // A deterministic pseudo-random sequence, so a failure is reproducible.
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 25; round += 1) {
      clients.forEach((client, i) => {
        const text = client.text;
        if (text.length > 4 && random() < 0.25) {
          text.delete(Math.floor(random() * (text.length - 2)), 2);
        } else {
          text.insert(Math.floor(random() * (text.length + 1)), String(i));
        }
      });
      if (round % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await eventually(() => {
      const first = clients[0].text.toString();
      return first.length > 0 && clients.every((client) => client.text.toString() === first);
    }, 10_000);
    const converged = clients[0].text.toString();

    await Promise.all(clients.map((client) => client.close()));
    await until(async () => (await storedText(doc.id)) === converged);
  });
});

describe('racing requests', () => {
  it('"save version" pressed on both instances at once creates exactly one revision', async () => {
    const a = await startInstance('a');
    const b = await startInstance('b');
    const ada = await registerUser(a, 'Ada');
    const doc = await createDocument(a, ada);
    const client = await openClient(a, ada, doc.id);
    await client.synced();

    // The first automatic save of a document with no history is checkpoint #1.
    client.text.insert(0, 'draft');
    await until(async () => (await prisma.documentRevision.count()) === 1);
    // Later edits are saved, but not checkpointed again within the interval.
    client.text.insert(5, ' -> release candidate');
    await until(async () => (await storedText(doc.id)) === 'draft -> release candidate');

    const save = (instance) => api(instance, ada).post(`/api/documents/${doc.id}/revisions`);
    const results = await Promise.all([save(a), save(b), save(a), save(b)]);

    // One request creates it (under the row lock); the others then find the
    // same text and return that revision instead of a duplicate.
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.revision.id)).size).toBe(1);
    const rows = await prisma.documentRevision.findMany({
      where: { documentId: doc.id },
      orderBy: { revisionNumber: 'asc' },
    });
    expect(rows.map((r) => [r.revisionNumber, r.kind])).toEqual([
      [1, 'AUTO'],
      [2, 'MANUAL'],
    ]);
  });

  it('numbers revisions without gaps or duplicates when different content is saved concurrently', async () => {
    const a = await startInstance('a');
    const b = await startInstance('b');
    const ada = await registerUser(a, 'Ada');
    const doc = await createDocument(a, ada);
    const onA = await openClient(a, ada, doc.id);
    const onB = await openClient(b, ada, doc.id);
    await Promise.all([onA.synced(), onB.synced()]);

    for (let i = 0; i < 5; i += 1) {
      onA.text.insert(onA.text.length, `edit ${i};`);
      await eventually(() => onB.text.toString() === onA.text.toString());
      await Promise.all([
        api(a, ada).post(`/api/documents/${doc.id}/revisions`),
        api(b, ada).post(`/api/documents/${doc.id}/revisions`),
      ]);
    }

    const numbers = (
      await prisma.documentRevision.findMany({
        where: { documentId: doc.id },
        orderBy: { revisionNumber: 'asc' },
      })
    ).map((r) => r.revisionNumber);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(numbers.length).toBeGreaterThanOrEqual(5);
  });
});
