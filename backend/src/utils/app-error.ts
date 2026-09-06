import type { ApiErrorCode } from '@collab/shared';

interface AppErrorOptions {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  /**
   * Whether `message` is safe to return to the client. 4xx messages are written
   * for users; 5xx messages are for logs only and are replaced in production.
   */
  expose?: boolean;
  cause?: unknown;
}

/**
 * The only error type services and controllers should throw deliberately.
 *
 * Carrying the HTTP status and the shared `ApiErrorCode` on the error means the
 * error middleware never has to guess how to translate a failure, and the code
 * the frontend switches on is the same union both sides import.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.expose = options.expose ?? options.status < 500;
  }

  static validation(message = 'Request validation failed', details?: unknown): AppError {
    return new AppError({ status: 422, code: 'VALIDATION_ERROR', message, details });
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError({ status: 400, code: 'VALIDATION_ERROR', message, details });
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError({ status: 401, code: 'UNAUTHENTICATED', message });
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppError {
    return new AppError({ status: 403, code: 'FORBIDDEN', message });
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError({ status: 404, code: 'NOT_FOUND', message });
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError({ status: 409, code: 'CONFLICT', message, details });
  }

  static payloadTooLarge(message = 'Payload too large'): AppError {
    return new AppError({ status: 413, code: 'PAYLOAD_TOO_LARGE', message });
  }

  static rateLimited(message = 'Too many requests'): AppError {
    return new AppError({ status: 429, code: 'RATE_LIMITED', message });
  }

  static internal(message = 'Internal server error', cause?: unknown): AppError {
    return new AppError({ status: 500, code: 'INTERNAL_ERROR', message, expose: false, cause });
  }
}
