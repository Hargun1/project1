/**
 * Origin and client-IP helpers shared by HTTP middleware and the WebSocket
 * upgrade handler (Phase 11).
 */

/**
 * Is a request's `Origin` header acceptable?
 *
 * Browsers attach `Origin` to cross-site requests, to every POST, and to every
 * WebSocket handshake. A request *without* it comes from a non-browser client
 * (curl, a server, a test), which cannot carry a victim's cookies, so it is
 * allowed: the purpose here is to stop a malicious *web page* from using a
 * logged-in user's browser (CSRF, cross-site WebSocket hijacking).
 *
 * @param {string | undefined} origin
 * @param {string[]} allowed  exact origins, e.g. ['http://localhost:5173']
 */
export function isAllowedOrigin(origin, allowed) {
  return origin === undefined || allowed.includes(origin);
}

/** `CLIENT_URL` may carry a path; an Origin never does. */
export function originOf(url) {
  return new URL(url).origin;
}

/**
 * Client IP for rate limiting a raw upgrade request, computed exactly like
 * Express's `trust proxy = <hops>` (so HTTP and WebSocket limits agree).
 *
 * Each trusted proxy appends the address it received the connection from to
 * X-Forwarded-For. With `hops` trusted proxies, the client is the entry `hops`
 * positions from the right. Anything further left was written by the client
 * itself and could be forged, which is why the count must match the real
 * deployment (TRUST_PROXY_HOPS).
 *
 * @param {import('http').IncomingMessage} req
 * @param {number} hops  number of trusted reverse proxies in front of the app
 */
export function clientIpOf(req, hops) {
  const forwarded = req.headers['x-forwarded-for'];
  if (hops > 0 && typeof forwarded === 'string' && forwarded.length > 0) {
    const chain = forwarded.split(',').map((part) => part.trim());
    // The socket peer is the nearest proxy; X-Forwarded-For lists the hops before it.
    const index = chain.length - hops;
    if (index >= 0) return chain[index];
    return chain[0];
  }
  return req.socket.remoteAddress ?? 'unknown';
}
