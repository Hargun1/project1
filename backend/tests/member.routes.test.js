import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { isApiErrorResponse } from '@collab/shared';

/**
 * Member management through the real Express app (routing, JWT auth, Zod,
 * permission matrix, error envelope). Repositories and the hub are faked.
 */

const DOC = '55555555-5555-4555-8555-555555555555';
const USERS = {
  owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  editor: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  viewer: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  stranger: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  newcomer: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};

const db = vi.hoisted(() => ({ members: new Map() }));

const member = (userId) => {
  const role = db.members.get(userId);
  return role
    ? { userId, name: userId.slice(0, 4), email: `${userId}@x.test`, role, createdAt: new Date() }
    : null;
};

vi.mock('../src/repositories/document.repository.js', () => ({
  getDocumentWithRole: vi.fn(async (documentId, userId) =>
    documentId === DOC ? { document: { id: DOC }, role: db.members.get(userId) ?? null } : null,
  ),
}));

vi.mock('../src/repositories/user.repository.js', () => ({
  findPublicByEmail: vi.fn(async (email) => {
    const id = Object.values(USERS).find((u) => `${u}@x.test` === email);
    return id ? { id, name: id.slice(0, 4), email } : null;
  }),
}));

vi.mock('../src/repositories/member.repository.js', () => ({
  listMembers: vi.fn(async () => [...db.members.keys()].map(member)),
  findMember: vi.fn(async (_doc, userId) => member(userId)),
  addMember: vi.fn(async (_doc, userId, role) => {
    if (db.members.has(userId)) return null;
    db.members.set(userId, role);
    return member(userId);
  }),
  updateMemberRole: vi.fn(async (_doc, userId, role) => {
    db.members.set(userId, role);
    return member(userId);
  }),
  removeMember: vi.fn(async (_doc, userId) => {
    db.members.delete(userId);
  }),
}));

const { createApp } = await import('../src/app.js');
const { generateAccessToken } = await import('../src/auth/token.service.js');

const hub = { notifyAccessChanged: vi.fn() };
const app = createApp({ hub });

const as = (who) => ({
  Authorization: `Bearer ${generateAccessToken({ id: USERS[who], email: `${who}@x.test`, name: who })}`,
});
const url = (userId) => `/api/documents/${DOC}/members${userId ? `/${userId}` : ''}`;

beforeEach(() => {
  db.members = new Map([
    [USERS.owner, 'OWNER'],
    [USERS.editor, 'EDITOR'],
    [USERS.viewer, 'VIEWER'],
  ]);
  hub.notifyAccessChanged.mockClear();
});

describe('listing members', () => {
  it.each(['owner', 'editor', 'viewer'])('is allowed for the %s', async (who) => {
    const res = await request(app).get(url()).set(as(who));
    expect(res.status).toBe(200);
    expect(res.body.members.map((m) => m.role).sort()).toEqual(['EDITOR', 'OWNER', 'VIEWER']);
  });

  it('is refused for a non-member', async () => {
    const res = await request(app).get(url()).set(as('stranger'));
    expect(res.status).toBe(403);
    expect(isApiErrorResponse(res.body)).toBe(true);
  });
});

describe('inviting', () => {
  const invite = (who, body) => request(app).post(url()).set(as(who)).send(body);

  it('lets the owner invite an existing account as EDITOR or VIEWER', async () => {
    const res = await invite('owner', { email: `${USERS.newcomer}@x.test`, role: 'VIEWER' });
    expect(res.status).toBe(201);
    expect(res.body.member).toMatchObject({ userId: USERS.newcomer, role: 'VIEWER' });
  });

  it.each(['editor', 'viewer', 'stranger'])('is refused for the %s', async (who) => {
    const res = await invite(who, { email: `${USERS.newcomer}@x.test`, role: 'EDITOR' });
    expect(res.status).toBe(403);
    expect(db.members.has(USERS.newcomer)).toBe(false);
  });

  it('cannot hand out OWNER', async () => {
    const res = await invite('owner', { email: `${USERS.newcomer}@x.test`, role: 'OWNER' });
    expect(res.status).toBe(422);
  });

  it('answers 404 for an unknown email and 409 for an existing member', async () => {
    expect((await invite('owner', { email: 'nobody@x.test', role: 'EDITOR' })).status).toBe(404);
    expect(
      (await invite('owner', { email: `${USERS.viewer}@x.test`, role: 'EDITOR' })).status,
    ).toBe(409);
  });

  it('normalises the email before looking it up', async () => {
    const res = await invite('owner', {
      email: `  ${USERS.newcomer.toUpperCase()}@X.TEST `,
      role: 'EDITOR',
    });
    expect(res.status).toBe(201);
  });
});

describe('changing roles', () => {
  const change = (who, target, role) => request(app).patch(url(target)).set(as(who)).send({ role });

  it("lets the owner change a role and re-checks that user's open sockets", async () => {
    const res = await change('owner', USERS.editor, 'VIEWER');
    expect(res.status).toBe(200);
    expect(db.members.get(USERS.editor)).toBe('VIEWER');
    expect(hub.notifyAccessChanged).toHaveBeenCalledWith(DOC, USERS.editor);
  });

  it.each(['editor', 'viewer'])('is refused for the %s (no self-promotion)', async (who) => {
    const res = await change(who, USERS[who], 'EDITOR');
    expect(res.status).toBe(403);
  });

  it("never changes the owner's role", async () => {
    expect((await change('owner', USERS.owner, 'VIEWER')).status).toBe(409);
  });

  it('answers 404 for a non-member and for a malformed id', async () => {
    expect((await change('owner', USERS.stranger, 'VIEWER')).status).toBe(404);
    expect((await change('owner', 'not-a-uuid', 'VIEWER')).status).toBe(404);
  });
});

describe('removing and leaving', () => {
  const remove = (who, target) => request(app).delete(url(target)).set(as(who));

  it('lets the owner remove a member and re-checks their sockets', async () => {
    expect((await remove('owner', USERS.viewer)).status).toBe(204);
    expect(db.members.has(USERS.viewer)).toBe(false);
    expect(hub.notifyAccessChanged).toHaveBeenCalledWith(DOC, USERS.viewer);
  });

  it('lets any non-owner leave', async () => {
    expect((await remove('viewer', USERS.viewer)).status).toBe(204);
    expect(db.members.has(USERS.viewer)).toBe(false);
  });

  it('does not let an editor remove someone else', async () => {
    expect((await remove('editor', USERS.viewer)).status).toBe(403);
    expect(db.members.has(USERS.viewer)).toBe(true);
  });

  it('never removes the owner, not even by themselves', async () => {
    expect((await remove('owner', USERS.owner)).status).toBe(409);
    expect((await remove('editor', USERS.owner)).status).toBe(403);
  });
});
