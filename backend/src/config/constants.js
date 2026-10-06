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

