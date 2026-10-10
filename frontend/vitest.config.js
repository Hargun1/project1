import { defineConfig } from 'vitest/config';

// Unit tests for pure frontend modules (no DOM needed). Kept separate from
// vite.config.js so tests do not load the React/Tailwind build plugins.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globals: false,
  },
});
