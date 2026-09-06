import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorCode, ApiErrorResponse } from '@collab/shared';
import { AppError } from '../utils/app-error';
import { logger } from '../utils/logger';
import { isProduction } from '../config/env';

/** Terminal 404: reached only when no route matched. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
};

interface NormalizedError {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

function readProp(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const GENERIC_500 = 'Internal server error';

/**
 * Maps anything thrown anywhere in the stack onto exactly one response shape.
 *
 * Internal detail leaves the process only through the logs: in production a 5xx
 * always answers with a generic message plus the request id, so a user can quote
 * the id in a bug report without ever seeing a stack trace or SQL string (§27).
 */
function normalize(error: unknown): NormalizedError {
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

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
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

  const body: ApiErrorResponse = {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      requestId: req.requestId,
    },
  };

  res.status(normalized.status).json(body);
};
