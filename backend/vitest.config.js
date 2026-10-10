import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Integration tests need PostgreSQL and Redis: vitest.integration.config.js.
    exclude: ['tests/integration/**'],
    setupFiles: ['tests/setup.js'],
    // Explicit imports from 'vitest' rather than injected globals, so a test file
    // reads the same as any other module and ESLint needs no extra globals.
    globals: false,
    restoreMocks: true,
  },
});
