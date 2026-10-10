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
    // Worker threads, set per project (a root-level `pool` does not reach
    // projects). With the default child processes, about one run in four died
    // with ERR_IPC_CHANNEL_CLOSED from the process pool; with threads, 17
    // consecutive runs passed. Native modules (Prisma's engine, bcrypt) work in
    // worker threads.
    projects: [
      { extends: './vitest.config.js', test: { pool: 'threads' } },
      { extends: './vitest.integration.config.js', test: { pool: 'threads' } },
    ],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // server.js is the process entry point (listen, signals); it is exercised
      // by the Docker smoke and resilience tests, not in-process.
      exclude: ['src/server.js'],
      reporter: ['text-summary', 'text', 'html'],
      reportsDirectory: 'coverage',
      // A few points under what Phase 13 measured (94.8 / 88.7 / 94.7 / 94.8),
      // so a change that drops untested code fails CI, without flaking on noise.
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
