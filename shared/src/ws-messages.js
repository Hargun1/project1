/**
 * WebSocket message contracts shared between frontend and backend.
 *
 * Every message on the wire is a JSON object whose `type` is drawn from one of
 * the lists below. The backend validates inbound messages against a Zod
 * discriminated union that mirrors the client list; the frontend checks server
 * messages with `isServerMessage` before dispatching on `type`.
 *
 * One socket is bound to exactly one document — the document named in the
 * single-use ticket. Messages therefore carry no `documentId`: the server never
 * lets a client choose, after authentication, which document a payload applies to.
 *
 * Binary Yjs payloads (`stateVector`, `update`) are base64 strings; see
 * `encoding.js` for why.
 *
 * Sync protocol (Phase 6) — the same two-step exchange y-protocols uses, carried
 * in JSON instead of lib0 binary framing:
 *
 *   server → client  joined        { documentId, userId, userName, role }
 *   client → server  sync-step1    { stateVector }  "here is what I already have"
 *   server → client  sync-step2    { update }       everything the client is missing
 *   server → client  sync-step1    { stateVector }  "here is what I already have"
 *   client → server  sync-step2    { update }       edits made while offline
 *   both directions  update        { update }       live incremental edits
 *
 * Exchanging state vectors means a reconnecting client downloads only what it
 * missed, and uploads only what it typed while disconnected — never the whole
 * document (§21).
 */

// ── Client → Server ──────────────────────────────────────────────────────────

/**
 *   - `ping`        keepalive; the server answers `pong`
 *   - `sync-step1`  the client's state vector
 *   - `sync-step2`  the update the server is missing (answer to the server's step 1)
 *   - `update`      an incremental Yjs update produced by a local edit
 *   - `awareness`   a y-protocols awareness update: who I am, where my cursor is
 */
export const WS_CLIENT_MESSAGE_TYPES = ['ping', 'sync-step1', 'sync-step2', 'update', 'awareness'];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isClientMessageType(value) {
  return typeof value === 'string' && WS_CLIENT_MESSAGE_TYPES.includes(value);
}

// ── Server → Client ──────────────────────────────────────────────────────────

/**
 *   - `pong`         answer to `ping`
 *   - `error`        `{ code, message }` — see WS_ERROR_CODES
 *   - `joined`       authentication succeeded and the room was joined
 *   - `sync-step1`   the server's state vector
 *   - `sync-step2`   the update the client is missing
 *   - `update`       an incremental update made by another collaborator
 *   - `awareness`    presence of other collaborators (on join: everyone's;
 *                    afterwards: changes, including removals when someone leaves)
 *   - `saved`        `{ stateVector }` — the server durably persisted this state
 *   - `save-failed`  persisting failed; edits are still held in memory
 *   - `cluster`      `{ state: 'ok' | 'degraded' }` — whether edits currently
 *                    reach users connected to *other* backend instances (Redis)
 *   - `role`         `{ role }` — your role on this document changed while you
 *                    were connected (Phase 10). Removal or deletion closes the
 *                    socket instead (4003 / 4004).
 */
export const WS_SERVER_MESSAGE_TYPES = [
  'pong',
  'error',
  'joined',
  'sync-step1',
  'sync-step2',
  'update',
  'awareness',
  'saved',
  'save-failed',
  'cluster',
  'role',
];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isServerMessageType(value) {
  return typeof value === 'string' && WS_SERVER_MESSAGE_TYPES.includes(value);
}

/**
 * Structural check for a server-sent WebSocket message.
 *
 * Deliberately loose: it only checks that `type` is known. Each handler on the
 * client narrows further for the fields its type carries.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isServerMessage(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    isServerMessageType(value.type)
  );
}

/**
 * Codes carried by `{ type: 'error', code, message }`. An error message reports
 * a rejected *message*; the socket stays open. Problems that end the session
 * use a close code instead (WS_CLOSE_CODES).
 */
export const WS_ERROR_CODES = [
  /** Malformed JSON, unknown type, or a payload that fails validation. */
  'PROTOCOL_ERROR',
  /** The sender's role does not allow this message (e.g. a VIEWER editing). */
  'FORBIDDEN',
  /** The payload was well-formed base64 but Yjs could not apply it. */
  'INVALID_UPDATE',
];

/**
 * WebSocket close codes used by the server.
 *
 * Standard codes (RFC 6455) are 1000–1015. Application codes live in 4000–4999.
 */
export const WS_CLOSE_CODES = {
  /** Normal closure after the client or server initiated a clean close. */
  NORMAL: 1000,
  /** The ticket was invalid, expired, or already consumed. */
  AUTH_FAILED: 4001,
  /** The authenticated user does not have access to the requested document. */
  FORBIDDEN: 4003,
  /** The requested document does not exist. */
  DOCUMENT_NOT_FOUND: 4004,
  /** A protocol violation: malformed JSON, unknown message type, etc. */
  PROTOCOL_ERROR: 4007,
  /** The server is shutting down gracefully. */
  SERVER_SHUTDOWN: 4008,
  /** The document could not be loaded (e.g. PostgreSQL unavailable). Retryable. */
  DOCUMENT_UNAVAILABLE: 4009,
};

/**
 * Name of the `Y.Text` inside each document's `Y.Doc`. Every client must use
 * the same key or they would be editing different shared types.
 */
export const YDOC_TEXT_KEY = 'content';
