import { WebSocketServer } from 'ws';
import { WS_CLOSE_CODES } from '@collab/shared';
import { handleConnection } from './connection.js';
import { forEachConnection, clearAllRooms } from './rooms.js';
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
 * @returns {WebSocketServer}
 */
export function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    // Max incoming payload per frame. Prevents a single malicious frame from
    // exhausting memory. This is a transport-level limit; the application-level
    // document size limit (MAX_DOCUMENT_SIZE_BYTES) is enforced in Phase 11.
    maxPayload: 1_048_576, // 1 MiB
  });

  wss.on('connection', (ws, req) => {
    // `handleConnection` is async; errors are caught inside it and result in
    // a close with an appropriate code rather than crashing the process.
    handleConnection(ws, req).catch((err) => {
      logger.error({ err }, 'unhandled error in ws connection handler');
      try {
        ws.close(WS_CLOSE_CODES.AUTH_FAILED, 'Internal error');
      } catch {
        // Socket may already be closed.
      }
    });
  });

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
    // Notify every connection in every room.
    forEachConnection((conn) => {
      try {
        conn.ws.close(WS_CLOSE_CODES.SERVER_SHUTDOWN, 'Server shutting down');
      } catch {
        // already closed
      }
    });

    clearAllRooms();

    wss.close((err) => {
      if (err) {
        logger.warn({ err }, 'error closing WebSocketServer');
      }
      logger.info('WebSocket server closed');
      resolve();
    });
  });
}
