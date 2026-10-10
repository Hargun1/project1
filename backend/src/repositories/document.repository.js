import { prisma } from '../database/prisma.js';

/**
 * Data-access layer for `documents` and `document_members`.
 *
 * Every read filters `deletedAt: null` here, in one place, because forgetting
 * that filter in a handler is the classic soft-delete bug.
 *
 * `yjsState` is omitted from every metadata query: it is binary CRDT state that
 * only the collaboration layer reads (via `getDocumentState`), and Prisma would
 * otherwise serialise a `Bytes` column into JSON as an array of numbers.
 */
const OMIT_STATE = { yjsState: true };

export async function createDocument({ ownerId, name, language }) {
  // The document and its OWNER membership row must exist together or not at all.
  return prisma.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: { ownerId, name, language },
      omit: OMIT_STATE,
    });

    await tx.documentMember.create({
      data: { documentId: doc.id, userId: ownerId, role: 'OWNER' },
    });

    return doc;
  });
}

/**
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<{ document: object, role: string | null } | null>}
 *   null when the document does not exist (or is soft-deleted); `role` is null
 *   when it exists but the user is not a member.
 */
export async function getDocumentWithRole(id, userId) {
  const doc = await prisma.document.findFirst({
    where: { id, deletedAt: null },
    omit: OMIT_STATE,
    include: { owner: { select: { id: true, name: true, email: true } } },
  });
  if (!doc) return null;

  const member = await prisma.documentMember.findUnique({
    where: { documentId_userId: { documentId: id, userId } },
  });

  return { document: doc, role: member?.role ?? null };
}

export async function listUserDocuments(userId, { skip, take, search, language }) {
  const where = {
    deletedAt: null,
    members: { some: { userId } },
  };

  if (search) {
    where.name = { contains: search, mode: 'insensitive' };
  }
  if (language) {
    where.language = language;
  }

  const [documents, total] = await Promise.all([
    prisma.document.findMany({
      where,
      skip,
      take,
      orderBy: { updatedAt: 'desc' },
      omit: OMIT_STATE,
      include: {
        members: { where: { userId }, select: { role: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.document.count({ where }),
  ]);

  return { documents, total };
}

export async function updateDocument(id, data) {
  return prisma.document.update({ where: { id }, data, omit: OMIT_STATE });
}

export async function softDeleteDocument(id) {
  return prisma.document.update({
    where: { id },
    data: { deletedAt: new Date() },
    omit: OMIT_STATE,
  });
}

// ── Collaboration state (Phase 6) ────────────────────────────────────────────

/**
 * Load a document's persisted CRDT state.
 *
 * Not filtered on `deletedAt`: the WebSocket layer has already authorised the
 * connection, and a document deleted while open must still be able to load
 * and flush its final state rather than lose it.
 *
 * @param {string} id
 * @returns {Promise<Uint8Array | null>} `Y.encodeStateAsUpdate()` output, or null
 *   when the document has never been edited
 */
export async function getDocumentState(id) {
  const row = await prisma.document.findUnique({
    where: { id },
    select: { yjsState: true },
  });
  return row?.yjsState ? new Uint8Array(row.yjsState) : null;
}

/**
 * Run `fn` while holding a row lock on the document, for read-merge-write of its
 * CRDT state and the revision bookkeeping that goes with it.
 *
 * The lock (`SELECT … FOR UPDATE`) is what makes concurrent writers safe: with
 * several backend instances, two may save the same document at the same moment.
 * The second waits, then reads what the first committed, so it merges into it
 * rather than overwriting it — and it sees the revision the first one created,
 * so revision numbers and "is a new checkpoint due?" decisions cannot race.
 *
 * `fn` receives:
 *   current                    the stored state (Uint8Array) or null
 *   writeState(state)          replace the stored state (bumps `updatedAt`)
 *   latestRevision()           { id, revisionNumber, createdAt } | null
 *   revisionSnapshot(id)       Uint8Array
 *   createRevision(data)       insert; returns the public revision shape
 *
 * @template T
 * @param {string} id
 * @param {(ops: object) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLockedDocumentState(id, fn) {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw`
        SELECT yjs_state FROM documents WHERE id = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) {
        throw new Error(`document ${id} does not exist`);
      }
      const toBuffer = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      return fn({
        current: rows[0].yjs_state ? new Uint8Array(rows[0].yjs_state) : null,

        async writeState(state) {
          await tx.document.update({
            where: { id },
            data: { yjsState: toBuffer(state) },
            select: { id: true },
          });
        },

        latestRevision() {
          return tx.documentRevision.findFirst({
            where: { documentId: id },
            orderBy: { revisionNumber: 'desc' },
            select: REVISION_SELECT,
          });
        },

        async revisionSnapshot(revisionId) {
          const row = await tx.documentRevision.findUnique({
            where: { id: revisionId },
            select: { snapshot: true },
          });
          return new Uint8Array(row.snapshot);
        },

        createRevision({ revisionNumber, snapshot, createdById, kind, restoredFromNumber }) {
          return tx.documentRevision.create({
            data: {
              documentId: id,
              revisionNumber,
              snapshot: toBuffer(snapshot),
              createdById,
              kind,
              restoredFromNumber,
            },
            select: REVISION_SELECT,
          });
        },
      });
    },
    // A merge of a large document plus a revision insert can exceed Prisma's
    // 5 s default while another instance holds the lock.
    { timeout: 15_000, maxWait: 10_000 },
  );
}

/** The public shape of a revision: everything except the binary snapshot. */
export const REVISION_SELECT = {
  id: true,
  revisionNumber: true,
  kind: true,
  restoredFromNumber: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
};
