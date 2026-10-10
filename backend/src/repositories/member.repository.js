import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';

/**
 * Data access for `document_members` — who has which role on which document.
 *
 * The composite primary key `(document_id, user_id)` is the real guarantee that
 * a user has at most one role per document. Code checks first to produce
 * friendly errors, but under a race (two invites at once) only the constraint
 * is reliable; its violation is reported as `null` here and turned into a 409
 * by the service.
 */

const MEMBER_SELECT = {
  role: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true } },
};

/** Flatten `{ role, createdAt, user: {...} }` into the API shape. */
function toMember(row) {
  return {
    userId: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    createdAt: row.createdAt,
  };
}

/**
 * @param {string} documentId
 * @returns {Promise<object[]>} owner first, then by join date
 */
export async function listMembers(documentId) {
  const rows = await prisma.documentMember.findMany({
    where: { documentId },
    select: MEMBER_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  // Owner first, everyone else in the order they joined.
  return rows.map(toMember).sort((a, b) => Number(b.role === 'OWNER') - Number(a.role === 'OWNER'));
}

export async function findMember(documentId, userId) {
  const row = await prisma.documentMember.findUnique({
    where: { documentId_userId: { documentId, userId } },
    select: MEMBER_SELECT,
  });
  return row ? toMember(row) : null;
}

/**
 * @returns {Promise<object | null>} the new member, or null if they already are one
 */
export async function addMember(documentId, userId, role) {
  try {
    const row = await prisma.documentMember.create({
      data: { documentId, userId, role },
      select: MEMBER_SELECT,
    });
    return toMember(row);
  } catch (err) {
    // P2002 = unique constraint violation: the primary key already exists.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

export async function updateMemberRole(documentId, userId, role) {
  const row = await prisma.documentMember.update({
    where: { documentId_userId: { documentId, userId } },
    data: { role },
    select: MEMBER_SELECT,
  });
  return toMember(row);
}

export async function removeMember(documentId, userId) {
  await prisma.documentMember.delete({ where: { documentId_userId: { documentId, userId } } });
}
