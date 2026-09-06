import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Explicit imports from 'vitest' instead of injected globals, so test files
    // typecheck under the same tsconfig as src.
    globals: false,
    restoreMocks: true,
  },
});
