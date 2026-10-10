import { apiFetch } from './api.js';

/**
 * @param {string} accessToken
 * @param {{ name: string, language: string }} data
 * @returns {Promise<{ document: object }>}
 */
export async function createDocument(accessToken, data) {
  return apiFetch('/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(data),
  });
}

/**
 * @param {string} accessToken
 * @param {object} query
 * @returns {Promise<{ data: object[], meta: object }>}
 */
export async function listDocuments(
  accessToken,
  { page = 1, limit = 20, search = '', language = '', owner = 'all' } = {},
) {
  const params = new URLSearchParams();
  if (page) params.set('page', page);
  if (limit) params.set('limit', limit);
  if (search) params.set('search', search);
  if (language) params.set('language', language);
  if (owner && owner !== 'all') params.set('owner', owner);

  return apiFetch(`/api/documents?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * @param {string} accessToken
 * @param {string} id
 * @returns {Promise<{ document: object }>}
 */
export async function getDocument(accessToken, id) {
  return apiFetch(`/api/documents/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * @param {string} accessToken
 * @param {string} id
 * @param {{ name?: string, language?: string }} data
 * @returns {Promise<{ document: object }>}
 */
export async function updateDocument(accessToken, id, data) {
  return apiFetch(`/api/documents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(data),
  });
}

/**
 * @param {string} accessToken
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteDocument(accessToken, id) {
  await apiFetch(`/api/documents/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Request a single-use WebSocket connection ticket (§11).
 *
 * The ticket is short-lived and scoped to one (user, document) pair. The
 * client passes it as `?ticket=...` on the WebSocket URL instead of a raw JWT.
 *
 * @param {string} accessToken
 * @param {string} documentId
 * @returns {Promise<string>} the opaque ticket string
 */
export async function requestWsTicket(accessToken, documentId) {
  const result = await apiFetch(`/api/documents/${documentId}/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return result.ticket;
}

// ── Revision history (Phase 9) ───────────────────────────────────────────────

/**
 * @param {string} accessToken
 * @param {string} documentId
 * @param {{ page?: number, limit?: number }} [query]
 * @returns {Promise<{ data: object[], meta: { total: number, page: number, limit: number, totalPages: number } }>}
 */
export async function listRevisions(accessToken, documentId, { page = 1, limit = 20 } = {}) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  return apiFetch(`/api/documents/${documentId}/revisions?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * @returns {Promise<{ revision: object & { content: string } }>}
 */
export async function getRevision(accessToken, documentId, revisionId) {
  return apiFetch(`/api/documents/${documentId}/revisions/${revisionId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * "Save version". `created` is false when nothing changed since the latest one.
 *
 * @returns {Promise<{ revision: object, created: boolean }>}
 */
export async function createRevision(accessToken, documentId) {
  return apiFetch(`/api/documents/${documentId}/revisions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Restore an older revision. The result is a *new* revision; history is kept.
 *
 * @returns {Promise<{ revision: object, created: boolean }>}
 */
export async function restoreRevision(accessToken, documentId, revisionId) {
  return apiFetch(`/api/documents/${documentId}/revisions/${revisionId}/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ── Members (Phase 10) ───────────────────────────────────────────────────────

const json = (accessToken) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${accessToken}`,
});

/** @returns {Promise<{ members: { userId, name, email, role, createdAt }[] }>} */
export async function listMembers(accessToken, documentId) {
  return apiFetch(`/api/documents/${documentId}/members`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** Invite an existing account by email as EDITOR or VIEWER (owner only). */
export async function addMember(accessToken, documentId, { email, role }) {
  return apiFetch(`/api/documents/${documentId}/members`, {
    method: 'POST',
    headers: json(accessToken),
    body: JSON.stringify({ email, role }),
  });
}

/** Change a member's role (owner only). */
export async function updateMember(accessToken, documentId, userId, role) {
  return apiFetch(`/api/documents/${documentId}/members/${userId}`, {
    method: 'PATCH',
    headers: json(accessToken),
    body: JSON.stringify({ role }),
  });
}

/** Remove a member (owner), or leave the document (pass your own id). */
export async function removeMember(accessToken, documentId, userId) {
  await apiFetch(`/api/documents/${documentId}/members/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
