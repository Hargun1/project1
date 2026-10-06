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
export async function listDocuments(accessToken, { page = 1, limit = 20, search = '', language = '' } = {}) {
  const params = new URLSearchParams();
  if (page) params.set('page', page);
  if (limit) params.set('limit', limit);
  if (search) params.set('search', search);
  if (language) params.set('language', language);

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
 * Phase 4 — save plain-text document content.
 * @param {string} accessToken
 * @param {string} id
 * @param {string} content
 * @returns {Promise<{ document: object }>}
 */
export async function saveDocumentContent(accessToken, id, content) {
  return apiFetch(`/api/documents/${id}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ content }),
  });
}
