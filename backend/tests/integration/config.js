/**
 * Where the integration tests run (Phase 13).
 *
 * They use the real PostgreSQL and Redis from `npm run infra:up` (or the CI
 * service containers), but never the development data:
 *
 *   - a separate database, `collab_editor_test`, created and migrated by
 *     global-setup.js; its name must end in `_test`, or nothing runs, because
 *     every test truncates all tables;
 *   - Redis logical database 15, which every test empties with FLUSHDB. (Pub/Sub
 *     channels are not per-database, but test documents have fresh random ids.)
 *
 * Override with INTEGRATION_DATABASE_URL / INTEGRATION_REDIS_URL.
 */
export const DATABASE_URL =
  process.env.INTEGRATION_DATABASE_URL ??
  'postgresql://collab:collab_dev_password@localhost:5432/collab_editor_test?schema=public';

export const REDIS_URL = process.env.INTEGRATION_REDIS_URL ?? 'redis://localhost:6379/15';

/** Refuse anything that is not clearly a throwaway test database. */
export function assertTestDatabase(url) {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(
      `Integration tests truncate every table; refusing to use database "${name}". ` +
        'Its name must end in _test.',
    );
  }
  return name;
}

/** Refuse Redis database 0, the one the app uses by default. */
export function assertTestRedis(url) {
  const index = Number(new URL(url).pathname.slice(1) || 0);
  if (index === 0) {
    throw new Error('Integration tests run FLUSHDB; refusing Redis database 0.');
  }
  return index;
}
