import { isApiErrorResponse } from '@collab/shared';

/**
 * The single place the frontend talks HTTP.
 *
 * Failures are normalised into `ApiError` carrying the backend's own error code —
 * the same list the server imports from `@collab/shared` — so pages branch on a
 * code instead of parsing messages. The envelope is *validated* with
 * `isApiErrorResponse` before it is trusted, which matters more now that nothing
 * checks the shape at build time.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

/** `NETWORK_ERROR` is client-side only: the request never reached the server. */
export const NETWORK_ERROR = 'NETWORK_ERROR';

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, or 0 when the request never left
   * @param {string} code an API_ERROR_CODES member, or NETWORK_ERROR
   * @param {string} message safe to display
   * @param {string} [requestId] correlates with a backend log line
   */
  constructor(status, code, message, requestId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * @param {string} path
 * @param {RequestInit & { allowStatuses?: readonly number[] }} [options]
 *   `allowStatuses` lists statuses to treat as success. `/readyz` answers 503
 *   with a *valid* typed body when a dependency is down, and that body is exactly
 *   what we want to render — a successful read of a degraded state, not a failure.
 * @returns {Promise<unknown>} the parsed JSON body
 * @throws {ApiError}
 */
export async function apiFetch(path, options = {}) {
  const { allowStatuses, headers, ...init } = options;

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      // Refresh tokens live in an HttpOnly cookie from Phase 2 onward.
      credentials: 'include',
      ...init,
      headers: { Accept: 'application/json', ...headers },
    });
  } catch {
    throw new ApiError(
      0,
      NETWORK_ERROR,
      'Cannot reach the server. Check that the backend is running.',
    );
  }

  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  const payload = isJson ? await response.json() : undefined;

  const accepted = response.ok || (allowStatuses?.includes(response.status) ?? false);
  if (!accepted) {
    if (isApiErrorResponse(payload)) {
      throw new ApiError(
        response.status,
        payload.error.code,
        payload.error.message,
        payload.error.requestId,
      );
    }
    throw new ApiError(
      response.status,
      'INTERNAL_ERROR',
      `Request failed with status ${response.status}`,
    );
  }

  return payload;
}
