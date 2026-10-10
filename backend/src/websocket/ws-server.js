import { WebSocketServer } from 'ws';
import { WS_CLOSE_CODES } from '@collab/shared';
import { handleConnection } from './connection.js';
import { ACCESS_RECHECK_INTERVAL_MS, WS_MAX_PAYLOAD_BYTES } from '../config/constants.js';
import { createRoomRegistry } from './rooms.js';
import { logger } from '../utils/logger.js';

/**
 * Attach a `ws.WebSocketServer` to an existing Node HTTP server (§17).
 *
 * The WS server listens on a dedicated path (`/ws`) so Nginx can route
 * WebSocket upgrades there without interfering with REST traffic. The upgrade
 * is handled manually (`noServer: false`) to keep it simple; Phase 11 can add
 * rate limiting on upgrades by switching to `noServer: true` and handling the
 * `upgrade` event on the HTTP server.
 *
 * @param {import('http').Server} httpServer  the server returned by `app.listen()`
 * @param {object} deps
 * @param {object} deps.hub  the collaboration hub serving these sockets
 * @param {number} [deps.accessRecheckMs]  periodic role re-check (tests shorten it)
 * @returns {WebSocketServer}
 */
export function attachWebSocketServer(
  httpServer,
  { hub, accessRecheckMs = ACCESS_RECHECK_INTERVAL_MS },
) {
  const rooms = createRoomRegistry();
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    // Max incoming payload per frame. Prevents a single malicious frame from
    // exhausting memory. This is a transport-level limit; the application-level
    // document size limit (MAX_DOCUMENT_SIZE_BYTES) is enforced in Phase 11.
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });

  wss.on('connection', (ws, req) => {
    // `handleConnection` is async. An unexpected failure (e.g. Redis down while
    // consuming the ticket) closes with a *retryable* code: AUTH_FAILED would
    // make the client give up permanently over what is an infrastructure blip.
    handleConnection(ws, req, { hub, rooms, accessRecheckMs }).catch((err) => {
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
 * @param {WebSocketServer} wss
 * @returns {Promise<void>}
 */
export function closeWebSocketServer(wss) {
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

    wss.close((err) => {
      if (err) {
        logger.warn({ err }, 'error closing WebSocketServer');
      }
      logger.info('WebSocket server closed');
      resolve();
    });
  });
}
