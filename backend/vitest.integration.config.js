import { defineConfig } from 'vitest/config';

/**
 * Integration tests (Phase 13): the real app against real PostgreSQL and Redis.
 * Nothing below the HTTP/WebSocket boundary is mocked.
 *
 *   npm run infra:up && npm run test:integration
 *
 * Files run one at a time because they share one database and every test starts
 * by truncating it.
 */
export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    include: ['tests/integration/**/*.int.test.js'],
    globalSetup: ['tests/integration/global-setup.js'],
    setupFiles: ['tests/integration/env.js'],
    fileParallelism: false,
    globals: false,
    restoreMocks: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
