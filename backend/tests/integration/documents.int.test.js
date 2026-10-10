import { describe, expect, it } from 'vitest';
import {
  api,
  createDocument,
  prisma,
  registerUser,
  share,
  startInstance,
  useIntegrationStack,
} from './stack.js';

/**
 * Documents and members against real PostgreSQL: the queries, transactions,
 * constraints and soft delete that the unit tests replace with fakes.
 * Spec §38: create, get, invite, change role, delete; non-members cannot access.
 */

useIntegrationStack();

const docUrl = (id) => `/api/documents/${id}`;

describe('documents', () => {
  it('creates the document and its OWNER membership in one transaction', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');

    const doc = await createDocument(a, ada, 'main.js');

    const members = await prisma.documentMember.findMany({ where: { documentId: doc.id } });
    expect(members).toEqual([expect.objectContaining({ userId: ada.id, role: 'OWNER' })]);
    const fetched = await api(a, ada).get(docUrl(doc.id));
    expect(fetched.status).toBe(200);
    expect(fetched.body.document).toMatchObject({ id: doc.id, name: 'main.js', role: 'OWNER' });
    // CRDT state is never sent over REST.
    expect(fetched.body.document).not.toHaveProperty('yjsState');
  });

  it('lists only documents the user is a member of, newest first, paginated and searchable', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const bob = await registerUser(a, 'Bob');
    for (const name of ['alpha.js', 'beta.js', 'gamma.py']) await createDocument(a, ada, name);
    const shared = await createDocument(a, bob, 'shared-notes.md');
    await createDocument(a, bob, 'bobs-secret.js');
    await share(a, bob, shared.id, ada, 'VIEWER');

    const page1 = await api(a, ada).get('/api/documents?limit=2&page=1');
    expect(page1.status).toBe(200);
    expect(page1.body.meta).toEqual({ total: 4, page: 1, limit: 2, totalPages: 2 });
    expect(page1.body.data.map((d) => d.name)).toEqual(['shared-notes.md', 'gamma.py']);
    expect(page1.body.data[0].role).toBe('VIEWER');

    const page2 = await api(a, ada).get('/api/documents?limit=2&page=2');
    expect(page2.body.data.map((d) => d.name)).toEqual(['beta.js', 'alpha.js']);

    const search = await api(a, ada).get('/api/documents?search=ALPH');
    expect(search.body.data.map((d) => d.name)).toEqual(['alpha.js']);
  });

  it('filters by owner: documents I own vs documents shared with me', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const bob = await registerUser(a, 'Bob');
    await createDocument(a, ada, 'mine-1.js');
    await createDocument(a, ada, 'mine-2.js');
    const fromBob = await createDocument(a, bob, 'from-bob.js');
    await share(a, bob, fromBob.id, ada, 'EDITOR');

    const names = async (query) =>
      (await api(a, ada).get(`/api/documents${query}`)).body.data.map((d) => d.name).sort();

    expect(await names('')).toEqual(['from-bob.js', 'mine-1.js', 'mine-2.js']);
    expect(await names('?owner=me')).toEqual(['mine-1.js', 'mine-2.js']);
    expect(await names('?owner=others')).toEqual(['from-bob.js']);
    const meta = (await api(a, ada).get('/api/documents?owner=others')).body.meta;
    expect(meta.total).toBe(1);
    expect((await api(a, ada).get('/api/documents?owner=someone')).status).toBe(422);
  });

  it('refuses non-members (403), unknown ids (404) and malformed ids (404)', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const eve = await registerUser(a, 'Eve');
    const doc = await createDocument(a, ada);

    expect((await api(a, eve).get(docUrl(doc.id))).status).toBe(403);
    expect((await api(a, eve).post(`${docUrl(doc.id)}/ws-ticket`)).status).toBe(403);
    expect((await api(a, eve).get(`${docUrl(doc.id)}/revisions`)).status).toBe(403);
    expect((await api(a, ada).get(docUrl('6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b'))).status).toBe(
      404,
    );
    expect((await api(a, ada).get(docUrl('not-a-uuid'))).status).toBe(404);
  });

  it('lets only the owner rename or delete', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const bob = await registerUser(a, 'Bob');
    const doc = await createDocument(a, ada);
    await share(a, ada, doc.id, bob, 'EDITOR');

    expect((await api(a, bob).patch(docUrl(doc.id), { name: 'mine.js' })).status).toBe(403);
    expect((await api(a, bob).delete(docUrl(doc.id))).status).toBe(403);

    const renamed = await api(a, ada).patch(docUrl(doc.id), { name: 'renamed.js' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.document.name).toBe('renamed.js');
  });

  it('soft-deletes: the row stays, but nobody can see or open it any more', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const bob = await registerUser(a, 'Bob');
    const doc = await createDocument(a, ada);
    await share(a, ada, doc.id, bob, 'EDITOR');

    expect((await api(a, ada).delete(docUrl(doc.id))).status).toBe(204);

    const row = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    for (const user of [ada, bob]) {
      expect((await api(a, user).get(docUrl(doc.id))).status).toBe(404);
      expect((await api(a, user).get('/api/documents')).body.meta.total).toBe(0);
      expect((await api(a, user).post(`${docUrl(doc.id)}/ws-ticket`)).status).toBe(404);
    }
  });
});

describe('members', () => {
  it('invites by email (any case), changes the role, and removes', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const bob = await registerUser(a, 'Bob');
    const doc = await createDocument(a, ada);
    const members = `${docUrl(doc.id)}/members`;

    const invited = await api(a, ada).post(members, {
      email: `  ${bob.email.toUpperCase()} `,
      role: 'EDITOR',
    });
    expect(invited.status).toBe(201);
    expect((await api(a, bob).get(docUrl(doc.id))).body.document.role).toBe('EDITOR');

    expect((await api(a, ada).patch(`${members}/${bob.id}`, { role: 'VIEWER' })).status).toBe(200);
    expect((await api(a, bob).get(docUrl(doc.id))).body.document.role).toBe('VIEWER');

    expect((await api(a, ada).delete(`${members}/${bob.id}`)).status).toBe(204);
    expect((await api(a, bob).get(docUrl(doc.id))).status).toBe(403);
  });

  it('keeps exactly one owner: the owner cannot be demoted or removed, and OWNER cannot be granted', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const bob = await registerUser(a, 'Bob');
    const doc = await createDocument(a, ada);
    const members = `${docUrl(doc.id)}/members`;

    expect((await api(a, ada).post(members, { email: bob.email, role: 'OWNER' })).status).toBe(422);
    expect((await api(a, ada).patch(`${members}/${ada.id}`, { role: 'EDITOR' })).status).toBe(409);
    expect((await api(a, ada).delete(`${members}/${ada.id}`)).status).toBe(409);
    expect(
      await prisma.documentMember.count({ where: { documentId: doc.id, role: 'OWNER' } }),
    ).toBe(1);
  });

  it('answers two simultaneous invites of the same person with 201 and 409 (primary key)', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const bob = await registerUser(a, 'Bob');
    const doc = await createDocument(a, ada);
    const invite = () =>
      api(a, ada).post(`${docUrl(doc.id)}/members`, { email: bob.email, role: 'EDITOR' });

    const statuses = (await Promise.all([invite(), invite(), invite()]))
      .map((r) => r.status)
      .sort();

    expect(statuses).toEqual([201, 409, 409]);
    expect(await prisma.documentMember.count({ where: { documentId: doc.id } })).toBe(2);
  });

  it('lets editors and viewers read the member list but not change it', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const bob = await registerUser(a, 'Bob');
    const cy = await registerUser(a, 'Cy');
    const doc = await createDocument(a, ada);
    await share(a, ada, doc.id, bob, 'EDITOR');
    const members = `${docUrl(doc.id)}/members`;

    const list = await api(a, bob).get(members);
    expect(list.status).toBe(200);
    expect(list.body.members.map((m) => m.role).sort()).toEqual(['EDITOR', 'OWNER']);
    expect((await api(a, bob).post(members, { email: cy.email, role: 'VIEWER' })).status).toBe(403);
    // ...but anyone may leave.
    expect((await api(a, bob).delete(`${members}/${bob.id}`)).status).toBe(204);
  });
});
