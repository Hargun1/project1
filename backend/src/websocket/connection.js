import { WS_CLOSE_CODES } from '@collab/shared';
import { consumeTicket } from './ticket.service.js';
import { parseClientMessage } from './ws-schemas.js';
import { joinRoom, leaveRoom, broadcastToRoom, sendToConnection } from './rooms.js';
import { logger } from '../utils/logger.js';
import { prisma } from '../database/prisma.js';

/**
 * WebSocket connection lifecycle (§17, §21).
 *
 * After the HTTP upgrade succeeds the connection is not yet "authenticated".
 * Authentication happens immediately in `handleConnection()`:
 *
 *   1. Extract the `ticket` query parameter from the upgrade URL.
 *   2. Consume the ticket (validate + delete from Redis).
 *   3. Verify the user has access to the requested document.
 *   4. Join the document room.
 *   5. Start the heartbeat interval.
 *   6. Listen for messages and dispatch them.
 *
 * If any step fails the socket is closed with an application-level close code
 * (4001–4008) defined in `@collab/shared`.
 */

/** Server-side ping interval (30 s). Clients that don't respond are terminated. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Called once for every new WebSocket connection after the HTTP upgrade.
 *
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} req
 */
export async function handleConnection(ws, req) {
  // ── 1. Extract ticket from query string ──────────────────────────────
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ticket = url.searchParams.get('ticket');

  if (!ticket) {
    ws.close(WS_CLOSE_CODES.AUTH_FAILED, 'Missing ticket');
    return;
  }

  // ── 2. Consume ticket (single-use, atomic) ──────────────────────────
  const ticketData = await consumeTicket(ticket);

  if (!ticketData) {
    ws.close(WS_CLOSE_CODES.AUTH_FAILED, 'Invalid or expired ticket');
    return;
  }

  const { userId, documentId } = ticketData;

  // ── 3. Verify document access ────────────────────────────────────────
  let userName;
  try {
    const [doc, member, user] = await Promise.all([
      prisma.document.findFirst({
        where: { id: documentId, deletedAt: null },
        select: { id: true, name: true },
      }),
      prisma.documentMember.findUnique({
        where: { documentId_userId: { documentId, userId } },
        select: { role: true },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      }),
    ]);

    if (!doc) {
      ws.close(WS_CLOSE_CODES.DOCUMENT_NOT_FOUND, 'Document not found');
      return;
    }

    if (!member) {
      ws.close(WS_CLOSE_CODES.FORBIDDEN, 'Access denied');
      return;
    }

    userName = user?.name ?? 'Unknown';
  } catch (err) {
    logger.error({ err, userId, documentId }, 'ws auth: database lookup failed');
    ws.close(WS_CLOSE_CODES.AUTH_FAILED, 'Authentication failed');
    return;
  }

  // ── 4. Build connection context ──────────────────────────────────────
  const conn = {
    ws,
    userId,
    documentId,
    userName,
    isAlive: true,
  };

  // ── 5. Join the document room ────────────────────────────────────────
  joinRoom(documentId, conn);

  logger.info(
    { userId, documentId, userName },
    'ws connection authenticated',
  );

  // Confirm join to the client
  sendToConnection(conn, {
    type: 'joined',
    documentId,
    userId,
    userName,
  });

  // ── 6. Heartbeat ─────────────────────────────────────────────────────
  // The server pings every HEARTBEAT_INTERVAL_MS. If the client does not
  // respond with a pong before the next ping, the connection is terminated.
  const heartbeat = setInterval(() => {
    if (!conn.isAlive) {
      logger.debug({ userId, documentId }, 'ws heartbeat missed — terminating');
      clearInterval(heartbeat);
      ws.terminate();
      return;
    }
    conn.isAlive = false;
    ws.ping();
  }, HEARTBEAT_INTERVAL_MS);

  ws.on('pong', () => {
    conn.isAlive = true;
  });

  // ── 7. Message handler ───────────────────────────────────────────────
  ws.on('message', (rawData) => {
    // Binary frames are not expected until Phase 6 adds binary sync.
    // For now, all messages are JSON text.
    let raw;
    if (typeof rawData === 'string') {
      raw = rawData;
    } else if (Buffer.isBuffer(rawData)) {
      raw = rawData.toString('utf8');
    } else {
      // ArrayBuffer / Buffer[] — convert
      raw = Buffer.from(rawData).toString('utf8');
    }

    const result = parseClientMessage(raw);

    if (!result.ok) {
      sendToConnection(conn, {
        type: 'error',
        code: 'PROTOCOL_ERROR',
        message: result.error,
      });
      return;
    }

    dispatchMessage(conn, result.message);
  });

  // ── 8. Close / error ─────────────────────────────────────────────────
  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    leaveRoom(documentId, conn);

    logger.info(
      { userId, documentId, code, reason: reason?.toString() },
      'ws connection closed',
    );
  });

  ws.on('error', (err) => {
    logger.warn({ err, userId, documentId }, 'ws connection error');
    // The 'close' event always fires after 'error', so cleanup happens there.
  });
}

// ── Message dispatcher ───────────────────────────────────────────────────────

/**
 * Route a validated message to the appropriate handler.
 *
 * Phase 5 implements `ping`. Phase 6 will add `sync` and `awareness` handlers.
 *
 * @param {object} conn
 * @param {object} message
 */
function dispatchMessage(conn, message) {
  switch (message.type) {
    case 'ping':
      sendToConnection(conn, { type: 'pong' });
      break;

    case 'sync':
      // Phase 6 — broadcast Yjs sync updates to the room
      broadcastToRoom(conn.documentId, {
        type: 'sync',
        data: message.data,
      }, conn);
      break;

    case 'awareness':
      // Phase 7 — broadcast awareness updates to the room
      broadcastToRoom(conn.documentId, {
        type: 'awareness',
        data: message.data,
      }, conn);
      break;

    default:
      sendToConnection(conn, {
        type: 'error',
        code: 'PROTOCOL_ERROR',
        message: `Unknown message type: ${message.type}`,
      });
  }
}
