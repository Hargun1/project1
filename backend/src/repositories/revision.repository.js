import { prisma } from '../database/prisma.js';
import { REVISION_SELECT } from './document.repository.js';

/**
 * Read access to `document_revisions`. Writes happen only inside
 * `withLockedDocumentState`, so they are serialised with saves.
 *
 * Not filtered by the document's `deletedAt`: callers authorise through
 * `getDocumentWithRole` first, which does filter it.
 */

/**
 * @param {string} documentId
 * @param {{ skip: number, take: number }} page
 * @returns {Promise<{ revisions: object[], total: number }>} newest first
 */
export async function listRevisions(documentId, { skip, take }) {
  const [revisions, total] = await Promise.all([
    prisma.documentRevision.findMany({
      where: { documentId },
      orderBy: { revisionNumber: 'desc' },
      skip,
      take,
      select: REVISION_SELECT,
    }),
    prisma.documentRevision.count({ where: { documentId } }),
  ]);
  return { revisions, total };
}

/**
 * @param {string} documentId
 * @param {string} revisionId
 * @returns {Promise<(object & { snapshot: Uint8Array }) | null>} null when the
 *   revision does not exist *for this document*
 */
export async function getRevisionWithSnapshot(documentId, revisionId) {
  const row = await prisma.documentRevision.findFirst({
    where: { id: revisionId, documentId },
    select: { ...REVISION_SELECT, snapshot: true },
  });
  return row ? { ...row, snapshot: new Uint8Array(row.snapshot) } : null;
}
