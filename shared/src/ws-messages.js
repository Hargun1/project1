/**
 * WebSocket message contracts shared between frontend and backend.
 *
 * Every message on the wire is a JSON object with a `type` field drawn from one
 * of these lists. The backend validates incoming messages against Zod schemas
 * that mirror the client union; the frontend validates server messages with the
 * `isServerMessage` guard.
 *
 * Phase 5 defines the transport skeleton: sync and awareness types are stubs
 * whose payloads Phase 6 (Yjs) will fill in. The discriminated-union approach
 * means adding a type later is just extending the list — existing handlers
 * continue to work.
 */

// ── Client → Server ──────────────────────────────────────────────────────────

/**
 * Message types the client may send after the socket is authenticated.
 *
 * Phase 5:
 *   - `ping` — client-initiated keepalive (server responds with `pong`)
 *
 * Phase 6 will add:
 *   - `sync`      — Yjs binary sync update (Uint8Array, base64-encoded)
 *   - `awareness`  — Yjs awareness update (Uint8Array, base64-encoded)
 */
export const WS_CLIENT_MESSAGE_TYPES = ['ping', 'sync', 'awareness'];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isClientMessageType(value) {
  return typeof value === 'string' && WS_CLIENT_MESSAGE_TYPES.includes(value);
}

// ── Server → Client ──────────────────────────────────────────────────────────

/**
 * Message types the server may send to an authenticated client.
 *
 * Phase 5:
 *   - `pong`       — response to `ping`
 *   - `error`      — structured error (code + message)
 *   - `joined`     — confirmation that the client joined a document room
 *
 * Phase 6 will add:
 *   - `sync`       — Yjs binary sync update forwarded from another client
 *   - `awareness`  — Yjs awareness update forwarded from another client
 */
export const WS_SERVER_MESSAGE_TYPES = ['pong', 'error', 'joined', 'sync', 'awareness'];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isServerMessageType(value) {
  return typeof value === 'string' && WS_SERVER_MESSAGE_TYPES.includes(value);
}

/**
 * Structural check for a valid server-sent WebSocket message.
 *
 * Deliberately loose: it only checks that `type` is known. Each handler on the
 * client side narrows further based on the type.
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
 * WebSocket close codes used by the server.
 *
 * Standard codes (RFC 6455) are 1000–1015. Application codes live in 4000–4999.
 * Documenting them here so both sides share the vocabulary.
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
};
