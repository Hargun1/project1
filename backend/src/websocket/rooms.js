import { logger } from '../utils/logger.js';

/**
 * Local connection registry (§17): which sockets on *this* WebSocket server
 * have which document open.
 *
 * Fan-out of edits does not go through here — each connection subscribes to its
 * document's Y.Doc, and other instances are reached through Redis (Phase 8).
 * The registry answers "who is connected locally to document X?", which access
 * revocation needs (Phase 10).
 *
 * A factory, one registry per WebSocket server, not a module-level map: two
 * servers in one process (the multi-instance tests) must not see each other's
 * sockets, or a test could pass without the cross-instance path working.
 */
export function createRoomRegistry() {
  /** @type {Map<string, Set<object>>} documentId → connections */
  const rooms = new Map();

  return {
    join(documentId, conn) {
      let room = rooms.get(documentId);
      if (!room) {
        room = new Set();
        rooms.set(documentId, room);
      }
      room.add(conn);
    },

    leave(documentId, conn) {
      const room = rooms.get(documentId);
      if (!room) return;
      room.delete(conn);
      if (room.size === 0) rooms.delete(documentId);
    },

    /** @returns {object[]} a copy, safe to iterate while connections close */
    connectionsFor(documentId) {
      return [...(rooms.get(documentId) ?? [])];
    },
  };
}

/**
 * Send a JSON payload to a single connection. Never throws: a socket that is
 * closing is skipped, a failed send is logged.
 *
 * @param {object} conn
 * @param {object} payload
 */
export function sendToConnection(conn, payload) {
  if (conn.ws.readyState !== conn.ws.OPEN) return;
  try {
    conn.ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn({ err, userId: conn.userId }, 'failed to send to connection');
  }
}
