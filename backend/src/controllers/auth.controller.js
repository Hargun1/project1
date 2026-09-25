import { registerSchema, loginSchema } from '../auth/auth.schemas.js';
import * as authService from '../auth/auth.service.js';
import { REFRESH_COOKIE_NAME } from '../config/constants.js';
import { env, isProduction } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

/**
 * Build the cookie options object for the refresh token.
 * `Secure` is only set in production (localhost doesn't serve over HTTPS).
 *
 * @param {number} maxAgeSeconds
 * @returns {import('express').CookieOptions}
 */
function refreshCookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    path: '/api/auth', // Only sent to auth endpoints — not every request.
    maxAge: maxAgeSeconds * 1000, // express uses milliseconds
  };
}

/**
 * Set the refresh token as an HttpOnly cookie on the response.
 *
 * @param {import('express').Response} res
 * @param {string} token
 */
function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions(env.REFRESH_TOKEN_EXPIRY_SECONDS));
}

/**
 * Clear the refresh cookie.
 *
 * @param {import('express').Response} res
 */
function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    path: '/api/auth',
  });
}

// ── Handlers ────────────────────────────────────────────────────────────────

/** POST /api/auth/register */
export async function register(req, res) {
  const data = registerSchema.parse(req.body);
  const result = await authService.register(data);

  setRefreshCookie(res, result.refreshToken);

  res.status(201).json({
    user: result.user,
    accessToken: result.accessToken,
  });
}

/** POST /api/auth/login */
export async function login(req, res) {
  const data = loginSchema.parse(req.body);
  const result = await authService.login(data);

  setRefreshCookie(res, result.refreshToken);

  res.status(200).json({
    user: result.user,
    accessToken: result.accessToken,
  });
}

/** POST /api/auth/refresh */
export async function refresh(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) {
    throw AppError.unauthenticated('No refresh token provided');
  }

  const result = await authService.refresh(token);

  setRefreshCookie(res, result.refreshToken);

  res.status(200).json({
    accessToken: result.accessToken,
  });
}

/** POST /api/auth/logout */
export async function logoutHandler(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (token) {
    await authService.logout(token);
  }

  clearRefreshCookie(res);
  res.status(204).end();
}

/** GET /api/auth/me */
export async function getMe(req, res) {
  const user = await authService.getMe(req.user.id);
  res.status(200).json({ user });
}
