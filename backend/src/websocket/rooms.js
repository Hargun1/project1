import { logger } from '../utils/logger.js';

/**
 * In-memory document room manager (§17).
 *
 * A "room" is the set of WebSocket connections currently editing a particular
 * document. This module is the single-instance version — it only knows about
 * connections on *this* server process. Phase 8 adds Redis Pub/Sub so updates
 * cross server boundaries.
 *
 * Each room key is `document:<documentId>`.
 *
 * Why a Map of Sets instead of a simple broadcast?  The server needs to:
 *   - enumerate who is in a room (for presence in Phase 7)
 *   - broadcast to everyone *except* the sender
 *   - clean up when a connection drops
 *
 * Thread safety is not a concern: Node runs on a single thread.
 */

/**
 * Map of `documentId` → Set<WebSocket-like connection objects>.
 *
 * Each connection object stored here is expected to have at least:
 *   - `ws`         — the raw `ws.WebSocket` instance
 *   - `userId`     — the authenticated user's ID
 *   - `documentId` — the document this connection is scoped to
 *   - `userName`   — display name for presence
 *
 * @type {Map<string, Set<object>>}
 */
const rooms = new Map();

/**
 * Add a connection to a document room.
 *
 * @param {string} documentId
 * @param {object} conn  connection context (must include `ws`, `userId`, etc.)
 */
export function joinRoom(documentId, conn) {
  let room = rooms.get(documentId);
  if (!room) {
    room = new Set();
    rooms.set(documentId, room);
  }
  room.add(conn);

  logger.debug(
    { documentId, userId: conn.userId, roomSize: room.size },
    'client joined room',
  );
}

/**
 * Remove a connection from its room. If the room is now empty, delete it.
 *
 * @param {string} documentId
 * @param {object} conn
 */
export function leaveRoom(documentId, conn) {
  const room = rooms.get(documentId);
  if (!room) return;

  room.delete(conn);

  logger.debug(
    { documentId, userId: conn.userId, roomSize: room.size },
    'client left room',
  );

  if (room.size === 0) {
    rooms.delete(documentId);
    logger.debug({ documentId }, 'room empty — removed');
  }
}

/**
 * Send a JSON payload to every connection in the room *except* `excludeConn`.
 *
 * Silently skips connections whose socket is not in the OPEN state.
 *
 * @param {string} documentId
 * @param {object} payload       will be `JSON.stringify`'d
 * @param {object} [excludeConn] connection to skip (usually the sender)
 */
export function broadcastToRoom(documentId, payload, excludeConn) {
  const room = rooms.get(documentId);
  if (!room) return;

  const data = JSON.stringify(payload);

  for (const conn of room) {
    if (conn === excludeConn) continue;
    if (conn.ws.readyState !== conn.ws.OPEN) continue;

    try {
      conn.ws.send(data);
    } catch (err) {
      logger.warn(
        { err, documentId, userId: conn.userId },
        'failed to send to room member',
      );
    }
  }
}

/**
 * Send a JSON payload to a single connection.
 *
 * @param {object} conn
 * @param {object} payload
 */
export function sendToConnection(conn, payload) {
  if (conn.ws.readyState !== conn.ws.OPEN) return;

  try {
    conn.ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn(
      { err, userId: conn.userId },
      'failed to send to connection',
    );
  }
}

/**
 * Get all connections in a room (for presence enumeration).
 *
 * @param {string} documentId
 * @returns {Set<object>}  the connections, or an empty set
 */
export function getRoomConnections(documentId) {
  return rooms.get(documentId) ?? new Set();
}

/**
 * Get the total number of active rooms (for diagnostics / health).
 *
 * @returns {number}
 */
export function getRoomCount() {
  return rooms.size;
}

/**
 * Iterate over every connection in every room (used during shutdown).
 *
 * @param {(conn: object, documentId: string) => void} callback
 */
export function forEachConnection(callback) {
  for (const [documentId, room] of rooms) {
    for (const conn of room) {
      callback(conn, documentId);
    }
  }
}

/**
 * Remove all rooms and connections (used during shutdown).
 */
export function clearAllRooms() {
  rooms.clear();
}
