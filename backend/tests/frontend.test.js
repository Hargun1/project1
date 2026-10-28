import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { attachFrontend } from '../src/frontend.js';

const app = express();
attachFrontend(app, fileURLToPath(new URL('./fixtures/frontend/', import.meta.url)));
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

describe('single-origin frontend hosting', () => {
  it.each(['/', '/login', '/documents/550e8400-e29b-41d4-a716-446655440000'])(
    'serves the React entry point at %s',
    async (url) => {
      const response = await request(app).get(url);
      expect(response.status).toBe(200);
      expect(response.text).toContain('id="root"');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['content-security-policy']).toContain("worker-src 'self'");
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    },
  );

  it('serves bundled assets with their proper content type', async () => {
    const response = await request(app).get('/assets/app.css');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/css');
  });

  it.each(['/api/missing', '/ws', '/assets/missing.js', '/missing.js'])(
    'does not hide missing endpoints or assets behind SPA HTML: %s',
    async (url) => {
      const response = await request(app).get(url);
      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
    },
  );
});
