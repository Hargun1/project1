import { WebSocketServer } from 'ws';
import { WS_CLOSE_CODES } from '@collab/shared';
import { handleConnection } from './connection.js';
import {
  ACCESS_RECHECK_INTERVAL_MS,
  WS_CLOSE_GRACE_MS,
  WS_MAX_PAYLOAD_BYTES,
} from '../config/constants.js';
import { createRoomRegistry } from './rooms.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { clientIpOf, isAllowedOrigin, originOf } from '../security/origin.js';
import { warnStoreUnavailable } from '../security/rate-limit-store.js';

/**
 * Attach a `ws.WebSocketServer` to an existing Node HTTP server (§17).
 *
 * The server runs in `noServer` mode: this module handles the HTTP `upgrade`
 * itself, so a request can be refused with a plain HTTP status *before* any
 * WebSocket is allocated (Phase 11):
 *
 *   wrong path            → 404
 *   foreign Origin        → 403   (cross-site WebSocket hijacking defence)
 *   too many attempts/IP  → 429   (connection flooding defence)
 *
 * Authentication (the ticket) and authorisation still happen in
 * `handleConnection`, after the upgrade.
 *
 * @param {import('http').Server} httpServer  the server returned by `app.listen()`
 * @param {object} deps
 * @param {object} deps.hub  the collaboration hub serving these sockets
 * @param {object} [deps.rateLimitStore]  connection-attempt counters; none = no limit (tests)
 * @param {string[]} [deps.allowedOrigins]  browser origins allowed to open sockets
 * @param {{ perSecond: number, burst: number }} [deps.messageRate]  per-socket message limit
 * @param {number} [deps.accessRecheckMs]  periodic role re-check (tests shorten it)
 * @returns {WebSocketServer}
 */
export function attachWebSocketServer(
  httpServer,
  {
    hub,
    rateLimitStore = null,
    allowedOrigins = [originOf(env.CLIENT_URL)],
    messageRate = { perSecond: env.WS_MESSAGES_PER_SECOND, burst: env.WS_MESSAGE_BURST },
    accessRecheckMs = ACCESS_RECHECK_INTERVAL_MS,
  },
) {
  const rooms = createRoomRegistry();
  const wss = new WebSocketServer({
    noServer: true,
    // Max incoming payload per frame: one malicious frame cannot exhaust memory.
    // The document size cap (MAX_DOCUMENT_SIZE_BYTES) is enforced by the hub.
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });

  /** Answer a refused upgrade with a minimal HTTP response and drop the socket. */
  const refuse = (socket, status, text) => {
    // HTTP requires CRLF line endings; the blank line ends the headers.
    socket.write(
      [`HTTP/1.1 ${status} ${text}`, 'Connection: close', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    socket.destroy();
  };

  const onUpgrade = async (req, socket, head) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname !== '/ws') return refuse(socket, 404, 'Not Found');

      if (!isAllowedOrigin(req.headers.origin, allowedOrigins)) {
        logger.warn({ origin: req.headers.origin }, 'ws upgrade refused: origin not allowed');
        return refuse(socket, 403, 'Forbidden');
      }

      if (rateLimitStore) {
        const ip = clientIpOf(req, env.TRUST_PROXY_HOPS);
        try {
          const { count } = await rateLimitStore.hit(`rl:ws-connect:${ip}`, 60_000);
          if (count > env.RATE_LIMIT_WS_CONNECT_PER_MINUTE) {
            return refuse(socket, 429, 'Too Many Requests');
          }
        } catch (err) {
          warnStoreUnavailable(err); // fail open, like the HTTP limiter
        }
      }

      return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (err) {
      logger.error({ err }, 'ws upgrade failed');
      return socket.destroy();
    }
  };
  httpServer.on('upgrade', onUpgrade);
  wss.on('close', () => httpServer.off('upgrade', onUpgrade));

  wss.on('connection', (ws, req) => {
    // `handleConnection` is async. An unexpected failure (e.g. Redis down while
    // consuming the ticket) closes with a *retryable* code: AUTH_FAILED would
    // make the client give up permanently over what is an infrastructure blip.
    handleConnection(ws, req, { hub, rooms, accessRecheckMs, messageRate }).catch((err) => {
      logger.error({ err }, 'unhandled error in ws connection handler');
      try {
        ws.close(WS_CLOSE_CODES.DOCUMENT_UNAVAILABLE, 'Internal error');
      } catch {
        // Socket may already be closed.
      }
    });
  });

  // Phase 10: someone's access changed (here or on another instance). Each
  // affected socket re-reads its role from PostgreSQL and is updated or closed.
  const onAccessChanged = ({ documentId, userId }) => {
    for (const conn of rooms.connectionsFor(documentId)) {
      if (userId === null || conn.userId === userId) void conn.recheckAccess();
    }
  };
  hub.events.on('access-changed', onAccessChanged);
  wss.on('close', () => hub.events.off('access-changed', onAccessChanged));

  wss.on('error', (err) => {
    logger.error({ err }, 'WebSocketServer error');
  });

  logger.info({ path: '/ws' }, 'WebSocket server attached');

  return wss;
}

/**
 * Gracefully shut down the WebSocket server.
 *
 * Sends a `SERVER_SHUTDOWN` close frame to every connected client, then closes
 * the underlying server so no new upgrades are accepted.
 *
 * `wss.close` resolves only once every client has finished the closing
 * handshake. A client that never answers the close frame (a frozen tab, a dead
 * network path, a hostile client) would hold it for `ws`'s 30 s close timeout,
 * longer than the whole shutdown budget, and the documents would never be
 * flushed (found in Phase 12 with `docker stop`). So after `graceMs` the
 * remaining sockets are terminated.
 *
 * @param {WebSocketServer} wss
 * @param {{ graceMs?: number }} [options]
 * @returns {Promise<void>}
 */
export function closeWebSocketServer(wss, { graceMs = WS_CLOSE_GRACE_MS } = {}) {
  return new Promise((resolve) => {
    // Every socket this server accepted, authenticated or not. Clients treat
    // SERVER_SHUTDOWN as retryable and reconnect — through the load balancer, to
    // another instance if there is one.
    for (const ws of wss.clients) {
      try {
        ws.close(WS_CLOSE_CODES.SERVER_SHUTDOWN, 'Server shutting down');
      } catch {
        // already closed
      }
    }

    const forceClose = setTimeout(() => {
      for (const ws of wss.clients) ws.terminate();
    }, graceMs);
    forceClose.unref();

    wss.close((err) => {
      clearTimeout(forceClose);
      if (err) {
        logger.warn({ err }, 'error closing WebSocketServer');
      }
      logger.info('WebSocket server closed');
      resolve();
    });
  });
}
