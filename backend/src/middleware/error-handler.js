import { ZodError } from 'zod';
import { AppError } from '../utils/app-error.js';
import { logger } from '../utils/logger.js';
import { isProduction } from '../config/env.js';

/** Terminal 404: reached only when no route matched. */
export const notFoundHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
};

function readProp(value, key) {
  return typeof value === 'object' && value !== null && key in value ? value[key] : undefined;
}

const GENERIC_500 = 'Internal server error';

/**
 * Maps anything thrown anywhere in the stack onto exactly one response shape:
 * `{ status, code, message, details? }`.
 *
 * Internal detail leaves the process only through the logs: in production a 5xx
 * always answers with a generic message plus the request id, so a user can quote
 * the id in a bug report without ever seeing a stack trace or SQL string (§27).
 */
function normalize(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.expose ? error.message : GENERIC_500,
      details: error.details,
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  // body-parser failures (express.json)
  const bodyParserType = readProp(error, 'type');
  if (bodyParserType === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
  }
  if (bodyParserType === 'entity.parse.failed') {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON' };
  }

  const message = readProp(error, 'message');
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    // Outside production the real message is far more useful than a generic one.
    message: isProduction || typeof message !== 'string' ? GENERIC_500 : message,
  };
}

export const errorHandler = (error, req, res, _next) => {
  const normalized = normalize(error);

  const context = {
    err: error,
    requestId: req.requestId,
    method: req.method,
    route: req.originalUrl,
    status: normalized.status,
    code: normalized.code,
  };

  if (normalized.status >= 500) {
    logger.error(context, 'request failed');
  } else {
    logger.warn(context, 'request rejected');
  }

  res.status(normalized.status).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      requestId: req.requestId,
    },
  });
};
