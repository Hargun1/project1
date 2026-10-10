import { hashPassword, verifyAgainstDummyHash, verifyPassword } from './password.service.js';
import {
  generateAccessToken,
  generateRefreshToken,
  storeRefreshSession,
  consumeRefreshSession,
  invalidateRefreshSession,
  verifyRefreshToken,
} from './token.service.js';
import * as userRepo from '../repositories/user.repository.js';
import { AppError } from '../utils/app-error.js';
import { logger } from '../utils/logger.js';

/**
 * Authentication business logic (§4 — never in route handlers).
 *
 * Every public method returns plain data; HTTP concerns (status codes, cookies)
 * belong in the controller.
 */

/**
 * Register a new user.
 *
 * @param {{ name: string, email: string, password: string }} data  already Zod-validated
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string, refreshJti: string }>}
 */
export async function register(data) {
  const existing = await userRepo.findByEmail(data.email);
  if (existing) {
    throw AppError.conflict('An account with this email already exists');
  }

  const passwordHash = await hashPassword(data.password);
  const user = await userRepo.createUser({
    name: data.name,
    email: data.email,
    passwordHash,
  });
  if (!user) {
    // Lost a race with a simultaneous registration for the same email.
    throw AppError.conflict('An account with this email already exists');
  }

  const accessToken = generateAccessToken(user);
  const { token: refreshToken, jti: refreshJti } = generateRefreshToken(user);
  await storeRefreshSession(user.id, refreshJti);

  logger.info({ userId: user.id }, 'user registered');

  return { user, accessToken, refreshToken, refreshJti };
}

/**
 * Authenticate an existing user.
 *
 * @param {{ email: string, password: string }} data  already Zod-validated
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string, refreshJti: string }>}
 */
export async function login(data) {
  const user = await userRepo.findByEmail(data.email);
  if (!user) {
    // Vague on purpose — never reveal whether the email exists. The message alone
    // is not enough: answering instantly here while a real account costs a
    // ~250 ms bcrypt comparison would reveal existence through *timing*. So an
    // unknown email pays for one comparison too (Phase 11).
    await verifyAgainstDummyHash(data.password);
    throw AppError.unauthenticated('Invalid email or password');
  }

  const valid = await verifyPassword(data.password, user.passwordHash);
  if (!valid) {
    throw AppError.unauthenticated('Invalid email or password');
  }

  // Strip passwordHash before generating tokens / returning user data.
  const { passwordHash: _, ...publicUser } = user;

  const accessToken = generateAccessToken(publicUser);
  const { token: refreshToken, jti: refreshJti } = generateRefreshToken(publicUser);
  await storeRefreshSession(publicUser.id, refreshJti);

  logger.info({ userId: publicUser.id }, 'user logged in');

  return { user: publicUser, accessToken, refreshToken, refreshJti };
}

/**
 * Rotate a refresh token: invalidate the old session, issue fresh tokens.
 *
 * @param {string} oldToken  the raw JWT from the cookie
 * @returns {Promise<{ accessToken: string, refreshToken: string, refreshJti: string }>}
 */
export async function refresh(oldToken) {
  let decoded;
  try {
    decoded = verifyRefreshToken(oldToken);
  } catch {
    throw AppError.unauthenticated('Invalid or expired refresh token');
  }

  // Atomically consume the old session (rotation): a token can be redeemed once.
  const userId = await consumeRefreshSession(decoded.jti);
  if (!userId) {
    // Session was revoked (logout) or already rotated.
    throw AppError.unauthenticated('Refresh session expired or revoked');
  }

  const user = await userRepo.findById(userId);
  if (!user) {
    throw AppError.unauthenticated('User no longer exists');
  }

  const accessToken = generateAccessToken(user);
  const { token: refreshToken, jti: refreshJti } = generateRefreshToken(user);
  await storeRefreshSession(user.id, refreshJti);

  return { accessToken, refreshToken, refreshJti };
}

/**
 * Logout: invalidate the refresh session.
 *
 * @param {string} token  the raw JWT from the cookie
 * @returns {Promise<void>}
 */
export async function logout(token) {
  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    // Token is already expired or malformed — nothing to revoke.
    return;
  }
  await invalidateRefreshSession(decoded.jti);
  logger.info({ userId: decoded.sub }, 'user logged out');
}

/**
 * Fetch the current user's profile.
 *
 * @param {string} userId  from `req.user.id` (set by auth middleware)
 * @returns {Promise<object>}
 */
export async function getMe(userId) {
  const user = await userRepo.findById(userId);
  if (!user) {
    throw AppError.notFound('User not found');
  }
  return user;
}
