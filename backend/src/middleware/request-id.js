import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Conservative shape check — an inbound header must never be able to forge log lines. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * @param {string | undefined} incoming value of the inbound x-request-id header
 * @returns {string} the inbound id when it is safe to reuse, otherwise a fresh UUID
 */
export function resolveRequestId(incoming) {
  return incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Assigns a request id and echoes it back on the response.
 *
 * Reusing a well-formed inbound `x-request-id` lets one id follow a request from
 * Nginx through whichever backend instance handled it — which is what makes logs
 * usable once there is more than one instance (§36).
 *
 * `req.requestId` rather than `req.id`, to avoid clashing with the `id` pino-http
 * sets on the underlying IncomingMessage.
 */
export const requestIdMiddleware = (req, res, next) => {
  const id = resolveRequestId(req.header(REQUEST_ID_HEADER));
  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};
