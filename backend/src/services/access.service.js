import { can } from '@collab/shared';
import * as docRepo from '../repositories/document.repository.js';
import { AppError } from '../utils/app-error.js';

/**
 * The one place a REST request is authorised against a document (Phase 10).
 *
 * Every per-document operation calls `requirePermission`, which:
 *   1. loads the document (soft-deleted counts as missing) and the caller's role
 *      in one place, so the 404 / 403 rules are identical everywhere;
 *   2. checks the action against the shared permission matrix (`can`), so the
 *      rules the UI shows and the rules the server enforces are literally the
 *      same table.
 *
 * Roles are read from PostgreSQL on every request, never from the access token:
 * a role change takes effect on the very next request.
 */

/**
 * @returns {Promise<{ document: object, role: string }>}
 * @throws 404 when the document does not exist, 403 when the caller is not a member
 */
export async function requireAccess(userId, documentId) {
  const result = await docRepo.getDocumentWithRole(documentId, userId);
  if (!result) throw AppError.notFound('Document not found');
  if (!result.role) throw AppError.forbidden('You do not have access to this document');
  return result;
}

/**
 * @param {string} userId
 * @param {string} documentId
 * @param {string} action  one of ACTIONS from @collab/shared
 * @param {string} [message]  what to tell a member who lacks the permission
 * @returns {Promise<{ document: object, role: string }>}
 */
export async function requirePermission(userId, documentId, action, message) {
  const result = await requireAccess(userId, documentId);
  if (!can(result.role, action)) {
    throw AppError.forbidden(message ?? `Your role (${result.role}) does not allow ${action}`);
  }
  return result;
}
