/**
 * `@collab/shared` — the one place a cross-boundary type is defined.
 *
 * Anything that travels between the browser and the server (roles, error
 * envelopes, DTOs, and from Phase 5 the WebSocket message union) lives here and
 * is imported by both `backend/` and `frontend/`.
 */
export * from './api';
export * from './health';
export * from './roles';
