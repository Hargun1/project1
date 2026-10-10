/**
 * The single error envelope every REST endpoint uses on failure.
 *
 * Shape (documented, since JavaScript cannot declare it):
 *
 *   {
 *     error: {
 *       code:       one of API_ERROR_CODES
 *       message:    safe to display to a user; never a stack trace or SQL
 *       details?:   field-level detail, e.g. flattened Zod issues
 *       requestId?: correlates with the backend log line that produced it
 *     }
 *   }
 *
 * Keeping the code list here means the frontend branches on the same vocabulary
 * the backend emits. Without a compiler to catch drift, `isApiErrorCode()` and
 * `isApiErrorResponse()` are the enforcement: the client validates the envelope
 * before trusting it rather than assuming the shape.
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
  /** Produced by Nginx, not the backend: no backend instance could answer (Phase 12). */
  'SERVICE_UNAVAILABLE',
];

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` is one of `API_ERROR_CODES`
 */
export function isApiErrorCode(value) {
  return typeof value === 'string' && API_ERROR_CODES.includes(value);
}

/**
 * Structural check that a response body really is the shared error envelope.
 *
 * Deliberately strict about `code` and `message`: a proxy returning an HTML error
 * page, or a future endpoint inventing its own shape, must not be mistaken for a
 * valid envelope and read blindly.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isApiErrorResponse(value) {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    isApiErrorCode(error.code) &&
    typeof error.message === 'string'
  );
}
