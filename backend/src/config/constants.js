/** Identity reported by /healthz and in log lines. */
export const SERVICE_NAME = 'collab-editor-backend';

export const SERVICE_VERSION = '0.1.0';

/** Request body cap (§12 "request size limits"). Yjs updates travel over WS, not REST. */
export const JSON_BODY_LIMIT = '100kb';

// ── Auth (Phase 2) ────────────────────────────────────────────────────────

/** bcrypt cost factor: 12 rounds ≈ ~250 ms per hash. */
export const BCRYPT_SALT_ROUNDS = 12;

/** Access token lifetime string for `jsonwebtoken`. */
export const ACCESS_TOKEN_EXPIRY = '15m';

/** Refresh token lifetime string for `jsonwebtoken`. */
export const REFRESH_TOKEN_EXPIRY = '7d';

/** Redis key prefix for refresh sessions. */
export const REFRESH_SESSION_PREFIX = 'refresh:';

/** Name of the HttpOnly cookie carrying the refresh token. */
export const REFRESH_COOKIE_NAME = 'collab_refresh';

// ── WebSocket (Phase 5) ───────────────────────────────────────────────────

/** Redis key prefix for single-use WebSocket connection tickets. */
export const WS_TICKET_PREFIX = 'ws_ticket:';

/** Server-side heartbeat ping interval in milliseconds. */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * On shutdown, how long clients get to answer the close frame before their
 * sockets are terminated (Phase 12). Well inside the 10 s shutdown budget, so
 * flushing documents always runs.
 */
export const WS_CLOSE_GRACE_MS = 2_000;

/**
 * How often an open socket re-reads its role from PostgreSQL (Phase 10).
 * Access changes are pushed instantly through Redis; this is the safety net
 * that bounds how long a revocation can be missed if that message is lost.
 */
export const ACCESS_RECHECK_INTERVAL_MS = 60_000;

/** Max inbound WebSocket frame. Transport-level guard; document size caps are Phase 11. */
export const WS_MAX_PAYLOAD_BYTES = 1_048_576;

// ── Collaboration (Phase 6) ───────────────────────────────────────────────

/**
 * Upper bound on how long continuous typing can postpone a save. A pure idle
 * debounce (`DOC_SNAPSHOT_DEBOUNCE_MS`) never fires while someone keeps typing,
 * which would make the crash-loss window unbounded.
 */
export const DOC_SNAPSHOT_MAX_WAIT_MS = 10_000;

/** Delay before retrying a failed save (e.g. PostgreSQL briefly unavailable). */
export const DOC_SAVE_RETRY_MS = 5_000;

/**
 * How long a newly opened session waits for peer instances to answer its hello
 * with their in-memory state before serving clients anyway (Phase 9).
 */
export const PEER_SYNC_TIMEOUT_MS = 1_000;
