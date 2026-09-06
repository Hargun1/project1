import { isApiErrorResponse, type ApiErrorCode } from '@collab/shared';

/**
 * The single place the frontend talks HTTP.
 *
 * Failures are normalised into `ApiError` carrying the backend's own
 * `ApiErrorCode` — the same union the server imports — so pages can branch on a
 * typed code instead of parsing messages.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

/** `NETWORK_ERROR` is client-side only: the request never reached the server. */
export type ApiFailureCode = ApiErrorCode | 'NETWORK_ERROR';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiFailureCode;
  readonly requestId?: string;

  constructor(status: number, code: ApiFailureCode, message: string, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface ApiFetchOptions extends RequestInit {
  /**
   * Statuses to treat as success. `/readyz` answers 503 with a *valid* typed
   * body when a dependency is down, and that body is exactly what we want to
   * render — so it is a successful read of a degraded state, not a failure.
   */
  allowStatuses?: readonly number[];
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { allowStatuses, headers, ...init } = options;

  let response: Response;
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
      'NETWORK_ERROR',
      'Cannot reach the server. Check that the backend is running.',
    );
  }

  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  const payload: unknown = isJson ? await response.json() : undefined;

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

  return payload as T;
}
