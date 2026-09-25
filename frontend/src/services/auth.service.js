import { apiFetch } from './api.js';

/**
 * Auth API calls.
 *
 * These wrap `apiFetch` with the correct path and method. The access token
 * lives in memory (AuthContext), never in localStorage. The refresh token
 * is an HttpOnly cookie managed entirely by the server.
 */

/**
 * @param {{ name: string, email: string, password: string }} data
 * @returns {Promise<{ user: object, accessToken: string }>}
 */
export async function register(data) {
  return apiFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

/**
 * @param {{ email: string, password: string }} data
 * @returns {Promise<{ user: object, accessToken: string }>}
 */
export async function login(data) {
  return apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

/**
 * @returns {Promise<{ accessToken: string }>}
 */
export async function refreshToken() {
  return apiFetch('/api/auth/refresh', { method: 'POST' });
}

/**
 * @returns {Promise<void>}
 */
export async function logout() {
  await apiFetch('/api/auth/logout', { method: 'POST' });
}

/**
 * @param {string} accessToken
 * @returns {Promise<{ user: object }>}
 */
export async function getMe(accessToken) {
  return apiFetch('/api/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
