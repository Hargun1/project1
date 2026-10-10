import * as docRepo from '../repositories/document.repository.js';
import { requireAccess, requirePermission } from './access.service.js';

/**
 * Document metadata operations. Authorisation goes through `access.service`,
 * which applies the shared permission matrix (§16).
 *
 * A non-member gets 403 rather than 404 so the client can tell "you were
 * removed" from "this never existed". The trade-off — confirming that a
 * document id exists — is acceptable because ids are unguessable UUIDs.
 */

export async function createDocument(userId, { name, language }) {
  return docRepo.createDocument({ ownerId: userId, name, language });
}

export async function getDocument(userId, documentId) {
  const { document, role } = await requireAccess(userId, documentId);
  return { ...document, role };
}

export async function listDocuments(userId, { page, limit, search, language, owner }) {
  const skip = (page - 1) * limit;
  const { documents, total } = await docRepo.listUserDocuments(userId, {
    skip,
    take: limit,
    search,
    language,
    owner,
  });

  const data = documents.map((doc) => {
    const { members, ...rest } = doc;
    return { ...rest, role: members[0]?.role };
  });

  return {
    data,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

/** Renaming and changing language are OWNER-only (§16: EDITOR cannot rename). */
export async function updateDocument(userId, documentId, data) {
  await requirePermission(
    userId,
    documentId,
    'document:rename',
    'Only the owner can rename or change the language of a document',
  );
  return docRepo.updateDocument(documentId, data);
}

/**
 * Soft delete (OWNER only), then tell every instance to re-check the sockets
 * open on this document: they are closed with 4004, because the document no
 * longer exists for anyone (§42 "document deleted while someone has it open").
 *
 * @param {object | null} hub  collaboration hub (null in tests without one)
 */
export async function deleteDocument(hub, userId, documentId) {
  await requirePermission(
    userId,
    documentId,
    'document:delete',
    'Only the owner can delete a document',
  );
  await docRepo.softDeleteDocument(documentId);
  hub?.notifyAccessChanged(documentId, null);
}
