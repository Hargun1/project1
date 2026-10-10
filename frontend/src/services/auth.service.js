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

/** The refresh request currently on the wire, shared by every concurrent caller. */
let refreshInFlight = null;

/**
 * Exchange the refresh cookie for a new access token.
 *
 * Concurrent callers share one request. The server rotates the refresh token
 * and accepts each one exactly once, so two simultaneous refreshes (React
 * StrictMode mounting twice, or the WebSocket client reconnecting while a page
 * loads) would otherwise race — and the loser would be logged out.
 *
 * @returns {Promise<{ accessToken: string }>}
 */
export function refreshToken() {
  refreshInFlight ??= apiFetch('/api/auth/refresh', { method: 'POST' }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
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
