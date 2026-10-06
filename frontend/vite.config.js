import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const BACKEND_ORIGIN = 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Read the single .env at the monorepo root instead of a second frontend copy.
  envDir: '..',

  // @collab/shared is plain ESM source in the workspace with no build step, so
  // leaving it out of the dependency pre-bundler means an edit to it hot-reloads
  // like any other file in the repo.
  optimizeDeps: {
    exclude: ['@collab/shared'],
  },

  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in development, exactly as Nginx will serve it in production —
    // so the client never needs to know a backend hostname.
    proxy: {
      '/api': { target: BACKEND_ORIGIN, changeOrigin: true },
      '/healthz': { target: BACKEND_ORIGIN, changeOrigin: true },
      '/readyz': { target: BACKEND_ORIGIN, changeOrigin: true },
      '/ws': { target: BACKEND_ORIGIN, changeOrigin: true, ws: true },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
