import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import {
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
  REFRESH_SESSION_PREFIX,
} from '../config/constants.js';
import { redis } from '../redis/redis.js';

/**
 * JWT token management (§11).
 *
 * Access tokens are short-lived and verified on every protected request.
 * Refresh tokens are long-lived, stored in Redis, and rotated on every refresh.
 *
 * Each refresh token carries a unique `jti` (JWT ID) that maps to a Redis key.
 * On refresh the old session is deleted and a new one is created — this is
 * refresh-token rotation: a stolen token can be used at most once before the
 * real owner's next refresh invalidates it.
 */

/**
 * @param {{ id: string, email: string, name: string }} user
 * @returns {string} a signed JWT
 */
export function generateAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY },
  );
}

/**
 * @param {{ id: string }} user
 * @returns {{ token: string, jti: string }} the signed JWT and its unique id
 */
export function generateRefreshToken(user) {
  const jti = randomUUID();
  const token = jwt.sign({ sub: user.id, jti }, env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
  return { token, jti };
}

/**
 * @param {string} token
 * @returns {object} decoded payload
 * @throws {jwt.JsonWebTokenError | jwt.TokenExpiredError}
 */
export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

/**
 * @param {string} token
 * @returns {object} decoded payload (includes `jti`)
 * @throws {jwt.JsonWebTokenError | jwt.TokenExpiredError}
 */
export function verifyRefreshToken(token) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET);
}

// ── Redis-backed refresh sessions ──────────────────────────────────────────

/**
 * Store a refresh session in Redis with a TTL matching the token lifetime.
 *
 * @param {string} userId
 * @param {string} jti  unique token id
 * @returns {Promise<void>}
 */
export async function storeRefreshSession(userId, jti) {
  const key = `${REFRESH_SESSION_PREFIX}${jti}`;
  // Store the userId so we can verify ownership during rotation.
  await redis.set(key, userId, 'EX', env.REFRESH_TOKEN_EXPIRY_SECONDS);
}

/**
 * @param {string} jti
 * @returns {Promise<string | null>} the userId, or null if expired/revoked
 */
export async function getRefreshSession(jti) {
  return redis.get(`${REFRESH_SESSION_PREFIX}${jti}`);
}

/**
 * Invalidate a single refresh session (logout or rotation).
 *
 * @param {string} jti
 * @returns {Promise<void>}
 */
export async function invalidateRefreshSession(jti) {
  await redis.del(`${REFRESH_SESSION_PREFIX}${jti}`);
}
