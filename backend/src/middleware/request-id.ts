import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Conservative shape check — an inbound header must never be able to forge log lines. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function resolveRequestId(incoming: string | undefined): string {
  return incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Assigns a request id and echoes it back on the response.
 *
 * Reusing a well-formed inbound `x-request-id` lets one id follow a request from
 * Nginx through whichever backend instance handled it — which is what makes logs
 * usable once there is more than one instance (§36).
 */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const id = resolveRequestId(req.header(REQUEST_ID_HEADER));
  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};
