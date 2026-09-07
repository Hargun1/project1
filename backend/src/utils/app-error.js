import { isApiErrorCode } from '@collab/shared';

/**
 * The only error type services and controllers should throw deliberately.
 *
 * Carrying the HTTP status and the shared error code on the error means the error
 * middleware never has to guess how to translate a failure, and the code the
 * frontend switches on is the same list both sides import.
 *
 * Options:
 *   status   HTTP status to answer with
 *   code     one of `API_ERROR_CODES` from @collab/shared
 *   message  human-readable; see `expose`
 *   details? field-level detail, e.g. flattened Zod issues
 *   expose?  whether `message` is safe to return to the client. 4xx messages are
 *            written for users; 5xx messages are for logs only and are replaced
 *            in production. Defaults to `status < 500`.
 *   cause?   the underlying error, preserved for the log
 */
export class AppError extends Error {
  constructor(options) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });

    // The compiler used to guarantee `code` was a member of the shared union. It
    // no longer can, and a typo here is not harmless: the client validates the
    // envelope, so a bogus code would be rejected wholesale and the real message
    // replaced by a generic one. Fail loudly at the throw site instead.
    if (!isApiErrorCode(options.code)) {
      throw new TypeError(
        `AppError received an unknown code: ${String(options.code)}. ` +
          `Use one of API_ERROR_CODES from @collab/shared.`,
      );
    }

    this.name = 'AppError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.expose = options.expose ?? options.status < 500;
  }

  static validation(message = 'Request validation failed', details) {
    return new AppError({ status: 422, code: 'VALIDATION_ERROR', message, details });
  }

  static badRequest(message, details) {
    return new AppError({ status: 400, code: 'VALIDATION_ERROR', message, details });
  }

  static unauthenticated(message = 'Authentication required') {
    return new AppError({ status: 401, code: 'UNAUTHENTICATED', message });
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError({ status: 403, code: 'FORBIDDEN', message });
  }

  static notFound(message = 'Resource not found') {
    return new AppError({ status: 404, code: 'NOT_FOUND', message });
  }

  static conflict(message, details) {
    return new AppError({ status: 409, code: 'CONFLICT', message, details });
  }

  static payloadTooLarge(message = 'Payload too large') {
    return new AppError({ status: 413, code: 'PAYLOAD_TOO_LARGE', message });
  }

  static rateLimited(message = 'Too many requests') {
    return new AppError({ status: 429, code: 'RATE_LIMITED', message });
  }

  static internal(message = 'Internal server error', cause) {
    return new AppError({ status: 500, code: 'INTERNAL_ERROR', message, expose: false, cause });
  }
}
