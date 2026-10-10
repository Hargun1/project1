/**
 * Authentication contracts shared between frontend and backend.
 *
 * Documented response shapes (JavaScript cannot declare them, so they are
 * described here and enforced with Zod on the backend / validated on the
 * frontend):
 *
 *   POST /api/auth/register → 201
 *   POST /api/auth/login    → 200
 *     { user: { id, name, email, createdAt }, accessToken }
 *     + HttpOnly cookie with the refresh token
 *
 *   POST /api/auth/refresh  → 200
 *     { accessToken }
 *     + new HttpOnly cookie (rotation)
 *
 *   POST /api/auth/logout   → 204 (no body)
 *     + clears the cookie
 *
 *   GET  /api/auth/me        → 200
 *     { user: { id, name, email, createdAt } }
 */

/**
 * The cookie name both sides agree on.  The backend writes it; the frontend
 * never reads it (HttpOnly), but needs the name for documentation.
 */
export const REFRESH_COOKIE_NAME = 'collab_refresh';

/**
 * Minimum password length enforced on both sides.
 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Maximum password length in UTF-8 *bytes*: bcrypt silently ignores everything
 * after the first 72 bytes.
 */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Maximum name length enforced on both sides.
 */
export const NAME_MAX_LENGTH = 100;
