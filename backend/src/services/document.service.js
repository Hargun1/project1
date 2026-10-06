import * as docRepo from '../repositories/document.repository.js';
import { AppError } from '../utils/app-error.js';

export async function createDocument(userId, { name, language }) {
  return docRepo.createDocument({ ownerId: userId, name, language });
}

export async function getDocument(userId, documentId) {
  const result = await docRepo.getDocumentWithRole(documentId, userId);
  if (!result || !result.document) {
    throw AppError.notFound('Document not found');
  }
  if (!result.role) {
    throw AppError.forbidden('You do not have access to this document');
  }
  return { ...result.document, role: result.role };
}

export async function listDocuments(userId, { page, limit, search, language }) {
  const skip = (page - 1) * limit;
  const { documents, total } = await docRepo.listUserDocuments(userId, { skip, take: limit, search, language });
  
  const mapped = documents.map(doc => {
    const role = doc.members[0]?.role;
    const { members: _members, ...rest } = doc;
    return { ...rest, role };
  });

  return {
    data: mapped,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
}

export async function updateDocument(userId, documentId, data) {
  const result = await docRepo.getDocumentWithRole(documentId, userId);
  if (!result || !result.document) {
    throw AppError.notFound('Document not found');
  }
  if (result.role !== 'OWNER' && result.role !== 'EDITOR') {
    throw AppError.forbidden('Only owners and editors can update documents');
  }
  
  // Actually, rename/language change should maybe be restricted to OWNER? 
  // Spec: OWNER — ... rename. EDITOR — ... Cannot delete, manage members, or change ownership.
  // So renaming is OWNER only. Let's enforce OWNER for updating document metadata.
  if (result.role !== 'OWNER') {
      throw AppError.forbidden('Only owners can rename or change language of a document');
  }

  return docRepo.updateDocument(documentId, data);
}

export async function deleteDocument(userId, documentId) {
  const result = await docRepo.getDocumentWithRole(documentId, userId);
  if (!result || !result.document) {
    throw AppError.notFound('Document not found');
  }
  if (result.role !== 'OWNER') {
    throw AppError.forbidden('Only the owner can delete a document');
  }

  return docRepo.softDeleteDocument(documentId);
}

/**
 * Phase 4 — save plain-text document content.
 * OWNER and EDITOR may write; VIEWER may not.
 */
export async function saveContent(userId, documentId, content) {
  const result = await docRepo.getDocumentWithRole(documentId, userId);
  if (!result || !result.document) {
    throw AppError.notFound('Document not found');
  }
  if (result.role !== 'OWNER' && result.role !== 'EDITOR') {
    throw AppError.forbidden('Only owners and editors can save content');
  }

  return docRepo.updateDocumentContent(documentId, content);
}
