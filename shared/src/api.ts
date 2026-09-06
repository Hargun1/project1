/**
 * The single error envelope every REST endpoint uses on failure.
 *
 * Keeping this in `shared/` means the frontend's error handling is typed against
 * exactly what the backend's error middleware emits — a new error code cannot be
 * introduced on one side without the other seeing it.
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  code: ApiErrorCode;
  /** Safe to display to a user; never contains stack traces or SQL. */
  message: string;
  /** Field-level detail, e.g. flattened Zod issues. */
  details?: unknown;
  /** Correlates the response with the backend log line that produced it. */
  requestId?: string;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
}

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const { error } = value as { error: unknown };
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    isApiErrorCode((error as { code: unknown }).code) &&
    typeof (error as { message: unknown }).message === 'string'
  );
}
