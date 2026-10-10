import { AppError } from '../utils/app-error.js';
import { isAllowedOrigin } from '../security/origin.js';

/**
 * CSRF defence for cookie-authenticated endpoints (Phase 11).
 *
 * Only `/api/auth/*` reads a cookie (the refresh token); every other endpoint
 * authenticates with an `Authorization` header that a foreign page cannot make
 * the browser attach, so those are not CSRF-able. For the auth endpoints, two
 * independent layers apply:
 *   1. the cookie is `SameSite` (Strict in production), so browsers do not send
 *      it on cross-site requests at all;
 *   2. this check: a state-changing request whose `Origin` is not our frontend
 *      is refused, whatever the browser's SameSite support.
 * A missing `Origin` means a non-browser client, which cannot hold a victim's
 * cookie, so it is allowed.
 *
 * @param {string[]} allowedOrigins
 */
export function requireTrustedOrigin(allowedOrigins) {
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!isAllowedOrigin(req.header('origin'), allowedOrigins)) {
      throw AppError.forbidden('Request origin is not allowed');
    }
    return next();
  };
}
