/**
 * `@collab/shared` — the one place a cross-boundary contract is defined.
 *
 * Anything that travels between the browser and the server (roles, error
 * envelopes, DTOs, and from Phase 5 the WebSocket message union) lives here and
 * is imported by both `backend/` and `frontend/`.
 *
 * In plain JavaScript this package cannot enforce a contract at compile time, so
 * it ships **runtime** guards (`isRole`, `isApiErrorCode`, `isApiErrorResponse`,
 * `isDependencyState`) plus the constant lists they check against. Call them at
 * trust boundaries — they are what is left of the type checking.
 *
 * ESM relative imports need the file extension; `./api` would not resolve.
 */
export * from './api.js';
export * from './auth.js';
export * from './health.js';
export * from './roles.js';
export * from './ws-messages.js';
