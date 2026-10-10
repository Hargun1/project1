import { can, fromBase64, toBase64, WS_CLOSE_CODES } from '@collab/shared';
import { consumeTicket } from './ticket.service.js';
import { parseClientMessage } from './ws-schemas.js';
import { sendToConnection } from './rooms.js';
import * as docRepo from '../repositories/document.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import {
  applyClientAwareness,
  encodeFullAwareness,
  releaseConnectionPresence,
} from '../services/presence.service.js';
import { encodeAwarenessUpdate } from 'y-protocols/awareness';
import { WS_HEARTBEAT_INTERVAL_MS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { createTokenBucket } from '../security/token-bucket.js';

/**
 * WebSocket connection lifecycle (§17, §21).
 *
 * After the HTTP upgrade the socket is open but *not* trusted. In order:
 *
 *   1. Consume the single-use ticket from `?ticket=` (atomic, so a replay fails).
 *   2. Re-check document access and role in PostgreSQL — the ticket proves who
 *      the user was 30 s ago, not that they are still a member now.
 *   3. Load (or share) the document's collaboration session.
 *   4. Join the room, announce `joined`, and start the Yjs sync handshake.
 *
 * Any failure closes the socket with an application close code (4001–4009)
 * from `@collab/shared`, so the client can tell "retry" from "give up".
 *
 * The client sends nothing until it receives `joined`, so no message can arrive
 * before the handlers below are attached.
 */

/**
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} req
 * @param {object} deps
 * @param {object} deps.hub              the collaboration hub
 * @param {object} deps.rooms            this server's connection registry
 * @param {number} deps.accessRecheckMs  periodic role re-check interval
 * @param {{ perSecond: number, burst: number }} deps.messageRate  per-socket message limit
 */
export async function handleConnection(ws, req, { hub, rooms, accessRecheckMs, messageRate }) {
  // ── 1. Ticket ─────────────────────────────────────────────────────────
  const url = new URL(req.url, 'http://localhost');
  const ticket = url.searchParams.get('ticket');
  if (!ticket) {
    ws.close(WS_CLOSE_CODES.AUTH_FAILED, 'Missing ticket');
    return;
  }

  const ticketData = await consumeTicket(ticket);
  if (!ticketData) {
    ws.close(WS_CLOSE_CODES.AUTH_FAILED, 'Invalid or expired ticket');
    return;
  }
  const { userId, documentId } = ticketData;

  // ── 2. Authorisation ──────────────────────────────────────────────────
  let access;
  let user;
  try {
    [access, user] = await Promise.all([
      docRepo.getDocumentWithRole(documentId, userId),
      userRepo.findById(userId),
    ]);
  } catch (err) {
    logger.error({ err, userId, documentId }, 'ws auth: database lookup failed');
    ws.close(WS_CLOSE_CODES.DOCUMENT_UNAVAILABLE, 'Document unavailable');
    return;
  }

  if (!access) {
    ws.close(WS_CLOSE_CODES.DOCUMENT_NOT_FOUND, 'Document not found');
    return;
  }
  if (!access.role || !user) {
    ws.close(WS_CLOSE_CODES.FORBIDDEN, 'Access denied');
    return;
  }

  // ── 3. Collaboration session ──────────────────────────────────────────
  let session;
  try {
    session = await hub.acquireSession(documentId);
  } catch (err) {
    logger.error({ err, documentId }, 'ws: failed to load document state');
    ws.close(WS_CLOSE_CODES.DOCUMENT_UNAVAILABLE, 'Document unavailable');
    return;
  }

  // The client may have given up while we were awaiting the database.
  if (ws.readyState !== ws.OPEN) {
    hub.releaseSession(session);
    return;
  }

  const conn = {
    ws,
    userId,
    documentId,
    userName: user.name,
    role: access.role,
    isAlive: true,
  };

  // ── 4. Wire the connection to the shared document ────────────────────
  // Forward every change to this client *except* the ones it sent itself:
  // `applyClientUpdate` tags updates with the sending connection as origin.
  const onDocUpdate = (update, origin) => {
    if (origin !== conn) {
      sendToConnection(conn, { type: 'update', update: toBase64(update) });
    }
  };
  // Presence changes from everyone else, including removals when someone leaves.
  const onAwarenessUpdate = ({ added, updated, removed }, origin) => {
    if (origin === conn) return;
    const changed = added.concat(updated, removed);
    sendToConnection(conn, {
      type: 'awareness',
      update: toBase64(encodeAwarenessUpdate(session.presence.awareness, changed)),
    });
  };
  const onSaved = (stateVector) => {
    sendToConnection(conn, { type: 'saved', stateVector: toBase64(stateVector) });
  };
  const onSaveFailed = () => {
    sendToConnection(conn, { type: 'save-failed' });
  };
  // Whether edits currently reach users on other backend instances (§43).
  const onClusterChange = (state) => {
    sendToConnection(conn, { type: 'cluster', state });
  };

  session.ydoc.on('update', onDocUpdate);
  session.presence.awareness.on('update', onAwarenessUpdate);
  session.events.on('saved', onSaved);
  session.events.on('save-failed', onSaveFailed);
  hub.events.on('cluster', onClusterChange);
  rooms.join(documentId, conn);

  // ── Access re-check (Phase 10, §42) ─────────────────────────────────────
  // Called when an access change is announced and periodically. The role is
  // re-read from PostgreSQL — never taken from the announcement — so a lost or
  // forged message cannot grant anything.
  conn.recheckAccess = async () => {
    let current;
    try {
      current = await docRepo.getDocumentWithRole(documentId, userId);
    } catch (err) {
      // Database unreachable: keep the socket as it is and try again later,
      // rather than disconnecting everyone during a database blip.
      logger.warn({ err, userId, documentId }, 'ws access re-check failed');
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    if (!current) {
      ws.close(WS_CLOSE_CODES.DOCUMENT_NOT_FOUND, 'Document was deleted');
    } else if (!current.role) {
      ws.close(WS_CLOSE_CODES.FORBIDDEN, 'Your access to this document was removed');
    } else if (current.role !== conn.role) {
      logger.info({ userId, documentId, from: conn.role, to: current.role }, 'ws role changed');
      conn.role = current.role;
      sendToConnection(conn, { type: 'role', role: current.role });
    }
  };
  const accessRecheck = setInterval(() => void conn.recheckAccess(), accessRecheckMs);

  // Heartbeat: a client that misses a ping round-trip is presumed dead. Without
  // this a half-open TCP connection would hold a room slot forever.
  const heartbeat = setInterval(() => {
    if (!conn.isAlive) {
      logger.debug({ userId, documentId }, 'ws heartbeat missed — terminating');
      ws.terminate();
      return;
    }
    conn.isAlive = false;
    ws.ping();
  }, WS_HEARTBEAT_INTERVAL_MS);

  ws.on('pong', () => {
    conn.isAlive = true;
  });

  // Message flood protection (Phase 11): a token bucket per socket. Over the
  // limit the socket is closed with a *retryable* code rather than messages
  // being dropped: dropping an edit would make this client's document diverge,
  // while a reconnect re-syncs through state vectors and loses nothing.
  const messageBucket = createTokenBucket({
    capacity: messageRate.burst,
    refillPerSecond: messageRate.perSecond,
  });

  ws.on('message', (rawData, isBinary) => {
    if (!messageBucket.take()) {
      logger.warn({ userId, documentId }, 'ws message rate exceeded — closing');
      ws.close(WS_CLOSE_CODES.RATE_LIMITED, 'Too many messages');
      return;
    }
    if (isBinary) {
      sendToConnection(conn, {
        type: 'error',
        code: 'PROTOCOL_ERROR',
        message: 'Binary frames are not supported; send JSON',
      });
      return;
    }
    const result = parseClientMessage(rawData.toString('utf8'));
    if (!result.ok) {
      sendToConnection(conn, { type: 'error', code: 'PROTOCOL_ERROR', message: result.error });
      return;
    }
    dispatchMessage(hub, conn, session, result.message);
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    clearInterval(accessRecheck);
    session.ydoc.off('update', onDocUpdate);
    session.presence.awareness.off('update', onAwarenessUpdate);
    releaseConnectionPresence(session.presence, conn);
    session.events.off('saved', onSaved);
    session.events.off('save-failed', onSaveFailed);
    hub.events.off('cluster', onClusterChange);
    rooms.leave(documentId, conn);
    hub.releaseSession(session);
    logger.info({ userId, documentId, code, reason: reason?.toString() }, 'ws connection closed');
  });

  ws.on('error', (err) => {
    // 'close' always follows 'error', so cleanup happens there.
    logger.warn({ err, userId, documentId }, 'ws connection error');
  });

  // `instance` in the log line is what proves, in a multi-instance demo, which
  // backend served which socket.
  logger.info(
    { userId, documentId, role: conn.role, instance: hub.instanceId },
    'ws connection authenticated',
  );

  sendToConnection(conn, {
    type: 'joined',
    documentId,
    userId,
    userName: conn.userName,
    role: conn.role,
  });
  // Our half of the handshake: the client answers with whatever we are missing
  // (edits it made while offline).
  sendToConnection(conn, {
    type: 'sync-step1',
    stateVector: toBase64(hub.encodeSessionStateVector(session)),
  });
  sendToConnection(conn, { type: 'cluster', state: hub.clusterState });
  // Who is already here, so a late joiner sees cursors immediately.
  const presence = encodeFullAwareness(session.presence);
  if (presence) {
    sendToConnection(conn, { type: 'awareness', update: toBase64(presence) });
  }
}

// ── Message dispatcher ───────────────────────────────────────────────────────

/**
 * @param {object} hub
 * @param {object} conn
 * @param {object} session
 * @param {object} message  already validated by `parseClientMessage`
 */
function dispatchMessage(hub, conn, session, message) {
  switch (message.type) {
    case 'ping':
      sendToConnection(conn, { type: 'pong' });
      return;

    case 'sync-step1': {
      const missing = hub.encodeMissingUpdate(session, fromBase64(message.stateVector));
      if (missing === null) {
        sendToConnection(conn, {
          type: 'error',
          code: 'PROTOCOL_ERROR',
          message: 'Malformed state vector',
        });
        return;
      }
      sendToConnection(conn, { type: 'sync-step2', update: toBase64(missing) });
      return;
    }

    case 'sync-step2':
    case 'update': {
      // Authorisation is enforced here, on the server, not by the read-only
      // editor in the browser: a VIEWER who hand-crafts a socket is still refused.
      // `conn.role` is kept current by `recheckAccess`, so a downgrade to VIEWER
      // takes effect here without the user reconnecting.
      if (!can(conn.role, 'document:edit')) {
        // A viewer's step 2 is its (empty) half of the handshake — not an edit.
        if (message.type === 'update') {
          sendToConnection(conn, {
            type: 'error',
            code: 'FORBIDDEN',
            message: 'Viewers cannot edit this document',
          });
        }
        return;
      }
      const result = hub.applyClientUpdate(session, fromBase64(message.update), conn);
      if (result === 'invalid') {
        sendToConnection(conn, {
          type: 'error',
          code: 'INVALID_UPDATE',
          message: 'Update could not be decoded',
        });
      } else if (result === 'too-large') {
        // Refused before applying, so the shared document is unchanged. The
        // client must drop its local copy and re-sync, or it would keep showing
        // (and re-sending on every reconnect) text nobody else has.
        sendToConnection(conn, {
          type: 'error',
          code: 'DOCUMENT_TOO_LARGE',
          message: `The document has reached its size limit (${Math.round(env.MAX_DOCUMENT_SIZE_BYTES / 1024)} KB); your last change was not saved.`,
        });
      }
      return;
    }

    case 'awareness': {
      // Viewers may publish presence: being seen reading is not editing.
      const result = applyClientAwareness(session.presence, conn, fromBase64(message.update));
      if (!result.ok) {
        sendToConnection(conn, { type: 'error', code: result.code, message: result.message });
      }
      return;
    }

    default:
      // Unreachable: the Zod union rejects unknown types first.
      sendToConnection(conn, {
        type: 'error',
        code: 'PROTOCOL_ERROR',
        message: `Unknown message type: ${message.type}`,
      });
  }
}
