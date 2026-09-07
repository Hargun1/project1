import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // Explicit imports from 'vitest' rather than injected globals, so a test file
    // reads the same as any other module and ESLint needs no extra globals.
    globals: false,
    restoreMocks: true,
  },
});
