import { verifyAccessToken } from '../auth/token.service.js';
import { AppError } from '../utils/app-error.js';

/**
 * Express middleware that protects routes behind JWT authentication (§10, §12).
 *
 * Extracts the `Authorization: Bearer <token>` header, verifies it, and attaches
 * the decoded payload to `req.user`. All downstream handlers can then trust
 * `req.user.id`, `req.user.email`, and `req.user.name`.
 *
 * If the header is missing or the token is invalid/expired, responds 401 via
 * `AppError.unauthenticated()` — the centralized error handler produces the
 * shared error envelope.
 */
export const authenticate = (req, _res, next) => {
  const header = req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    throw AppError.unauthenticated('Missing or malformed Authorization header');
  }

  const token = header.slice(7); // "Bearer ".length === 7
  try {
    const decoded = verifyAccessToken(token);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      name: decoded.name,
    };
    next();
  } catch {
    throw AppError.unauthenticated('Invalid or expired access token');
  }
};
