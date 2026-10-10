import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import * as Y from 'yjs';
import { isApiErrorResponse, YDOC_TEXT_KEY } from '@collab/shared';

/**
 * Revision endpoints through the real Express app — routing, JWT
 * authentication, validation, authorisation and the error envelope. The
 * repositories and the collaboration hub are faked.
 */

const DOC = '33333333-3333-4333-8333-333333333333';
const REV = '44444444-4444-4444-8444-444444444444';
const USERS = {
  owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  editor: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  viewer: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  stranger: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};
const ROLES = { [USERS.owner]: 'OWNER', [USERS.editor]: 'EDITOR', [USERS.viewer]: 'VIEWER' };

const snapshotOf = (text) => {
  const doc = new Y.Doc();
  doc.getText(YDOC_TEXT_KEY).insert(0, text);
  return Y.encodeStateAsUpdate(doc);
};
const revisionRow = {
  id: REV,
  revisionNumber: 2,
  kind: 'MANUAL',
  restoredFromNumber: null,
  createdAt: new Date('2026-10-09T12:00:00Z'),
  createdBy: { id: USERS.owner, name: 'Owner' },
};

vi.mock('../src/repositories/document.repository.js', () => ({
  getDocumentWithRole: vi.fn(async (documentId, userId) =>
    documentId === DOC ? { document: { id: DOC }, role: ROLES[userId] ?? null } : null,
  ),
}));

vi.mock('../src/repositories/revision.repository.js', () => ({
  listRevisions: vi.fn(async () => ({ revisions: [revisionRow], total: 1 })),
  getRevisionWithSnapshot: vi.fn(async (documentId, revisionId) =>
    documentId === DOC && revisionId === REV
      ? { ...revisionRow, snapshot: snapshotOf('old content') }
      : null,
  ),
}));

const { createApp } = await import('../src/app.js');
const { generateAccessToken } = await import('../src/auth/token.service.js');

const hub = {
  createRevision: vi.fn(),
  restoreRevision: vi.fn(),
};
const app = createApp({ hub });

const as = (who) => ({
  Authorization: `Bearer ${generateAccessToken({ id: USERS[who], email: `${who}@x.test`, name: who })}`,
});

beforeEach(() => {
  hub.createRevision.mockResolvedValue({
    revision: { ...revisionRow, revisionNumber: 3 },
    created: true,
  });
  hub.restoreRevision.mockResolvedValue({
    revision: { ...revisionRow, revisionNumber: 3, kind: 'RESTORE', restoredFromNumber: 2 },
    created: true,
  });
});

describe('reading history', () => {
  it('lets every member, including a viewer, list revisions newest-first with pagination', async () => {
    const res = await request(app)
      .get(`/api/documents/${DOC}/revisions?page=1&limit=10`)
      .set(as('viewer'));
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 1, page: 1, limit: 10, totalPages: 1 });
    expect(res.body.data[0]).toMatchObject({ revisionNumber: 2, kind: 'MANUAL' });
  });

  it('returns a revision as text and never as binary', async () => {
    const res = await request(app).get(`/api/documents/${DOC}/revisions/${REV}`).set(as('viewer'));
    expect(res.status).toBe(200);
    expect(res.body.revision.content).toBe('old content');
    expect(res.body.revision).not.toHaveProperty('snapshot');
  });

  it.each([
    ['a non-member', 'stranger', `/api/documents/${DOC}/revisions`, 403],
    ['an unknown document', 'owner', `/api/documents/${REV}/revisions`, 404],
    ['a malformed document id', 'owner', '/api/documents/nope/revisions', 404],
    ['a malformed revision id', 'owner', `/api/documents/${DOC}/revisions/nope`, 404],
    ["another document's revision", 'owner', `/api/documents/${DOC}/revisions/${DOC}`, 404],
  ])('refuses %s', async (_label, who, path, status) => {
    const res = await request(app).get(path).set(as(who));
    expect(res.status).toBe(status);
    expect(isApiErrorResponse(res.body)).toBe(true);
  });

  it('requires authentication', async () => {
    expect((await request(app).get(`/api/documents/${DOC}/revisions`)).status).toBe(401);
  });
});

describe('saving a version', () => {
  it.each(['owner', 'editor'])('is allowed for the %s (201 when new)', async (who) => {
    const res = await request(app).post(`/api/documents/${DOC}/revisions`).set(as(who));
    expect(res.status).toBe(201);
    expect(hub.createRevision).toHaveBeenLastCalledWith(DOC, USERS[who]);
  });

  it('answers 200 with the existing revision when nothing changed', async () => {
    hub.createRevision.mockResolvedValue({ revision: revisionRow, created: false });
    const res = await request(app).post(`/api/documents/${DOC}/revisions`).set(as('editor'));
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
  });

  it('is refused for a viewer', async () => {
    hub.createRevision.mockClear();
    const res = await request(app).post(`/api/documents/${DOC}/revisions`).set(as('viewer'));
    expect(res.status).toBe(403);
    expect(hub.createRevision).not.toHaveBeenCalled();
  });
});

describe('restoring', () => {
  it('is allowed for the owner and hands the target snapshot to the hub', async () => {
    const res = await request(app)
      .post(`/api/documents/${DOC}/revisions/${REV}/restore`)
      .set(as('owner'));
    expect(res.status).toBe(201);
    expect(res.body.revision).toMatchObject({ kind: 'RESTORE', restoredFromNumber: 2 });
    const [documentId, target, userId] = hub.restoreRevision.mock.lastCall;
    expect([documentId, target.revisionNumber, userId]).toEqual([DOC, 2, USERS.owner]);
    expect(target.snapshot).toBeInstanceOf(Uint8Array);
  });

  it.each(['editor', 'viewer', 'stranger'])('is refused for the %s', async (who) => {
    hub.restoreRevision.mockClear();
    const res = await request(app)
      .post(`/api/documents/${DOC}/revisions/${REV}/restore`)
      .set(as(who));
    expect(res.status).toBe(403);
    expect(hub.restoreRevision).not.toHaveBeenCalled();
  });

  it('is a 404 for a revision that does not exist', async () => {
    const res = await request(app)
      .post(`/api/documents/${DOC}/revisions/${DOC}/restore`)
      .set(as('owner'));
    expect(res.status).toBe(404);
  });
});
