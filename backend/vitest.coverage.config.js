import { defineConfig } from 'vitest/config';

/**
 * Coverage of the backend by *both* suites in one run (Phase 13): unit tests
 * reach the logic, integration tests reach the repositories, Redis code and
 * wiring that unit tests replace with fakes. Measured separately, each looks
 * worse than the truth.
 *
 *   npm run infra:up && npm run test:coverage --workspace @collab/backend
 *
 * Files run one at a time (the integration suite shares one database).
 */
export default defineConfig({
  test: {
    projects: ['./vitest.config.js', './vitest.integration.config.js'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // server.js is the process entry point (listen, signals); it is exercised
      // by the Docker smoke and resilience tests, not in-process.
      exclude: ['src/server.js'],
      reporter: ['text-summary', 'text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
