/**
 * Test environment defaults.
 *
 * Runs before any test file, so importing modules that read validated env (the
 * app, the logger) does not require a real .env. Unit tests never connect to
 * PostgreSQL or Redis; the integration tests (tests/integration, Phase 13) reuse
 * these values and point DATABASE_URL / REDIS_URL at real test databases.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.PORT = '4001';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.DATABASE_URL =
  'postgresql://collab:collab@localhost:5432/collab_editor_test?schema=public';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_SECRET = 'test-access-secret-value-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-at-least-32-characters';
process.env.DOC_SNAPSHOT_DEBOUNCE_MS = '50';
process.env.MAX_DOCUMENT_SIZE_BYTES = '65536'; // 64 KB: lets the size-cap test use a small payload
