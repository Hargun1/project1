import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { isApiErrorResponse } from '@collab/shared';

/**
 * Phase 11 HTTP protections: rate limiting, CSRF origin check, no-store
 * caching, password rules and login timing.
 */

vi.mock('../src/repositories/user.repository.js', () => ({
  findByEmail: vi.fn(async () => null), // every login is for an unknown account
}));

vi.mock('../src/auth/password.service.js', () => ({
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(async () => false),
  verifyAgainstDummyHash: vi.fn(async () => {}),
}));

const { createApp } = await import('../src/app.js');
const { rateLimit } = await import('../src/middleware/rate-limit.js');
const { errorHandler } = await import('../src/middleware/error-handler.js');
const { createMemoryRateLimitStore } = await import('../src/security/rate-limit-store.js');
const { createTokenBucket } = await import('../src/security/token-bucket.js');
const { clientIpOf } = await import('../src/security/origin.js');
const { registerSchema } = await import('../src/auth/auth.schemas.js');
const passwordService = await import('../src/auth/password.service.js');

const CLIENT_ORIGIN = 'http://localhost:5173'; // CLIENT_URL in tests/setup.js

/** A tiny app with one limited route, to test the middleware in isolation. */
function limitedApp({ store, limit = 3 }) {
  const app = express();
  app.get(
    '/thing',
    rateLimit({ store, name: 'test', limit, windowMs: 60_000, key: () => 'client-1' }),
    (_req, res) => res.json({ ok: true }),
  );
  app.use(errorHandler);
  return app;
}

describe('rate limiting middleware', () => {
  it('allows `limit` requests per window, then answers 429 with Retry-After', async () => {
    const app = limitedApp({ store: createMemoryRateLimitStore() });
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/thing');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-remaining']).toBe(String(2 - i));
    }
    const refused = await request(app).get('/thing');
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    expect(isApiErrorResponse(refused.body)).toBe(true);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('starts a fresh window once the old one expires', async () => {
    let now = 1_000_000;
    const app = limitedApp({ store: createMemoryRateLimitStore(() => now), limit: 1 });
    expect((await request(app).get('/thing')).status).toBe(200);
    expect((await request(app).get('/thing')).status).toBe(429);
    now += 60_001;
    expect((await request(app).get('/thing')).status).toBe(200);
  });

  it('fails open when the counter store is unreachable', async () => {
    const broken = { hit: async () => Promise.reject(new Error('redis down')) };
    const app = limitedApp({ store: broken, limit: 1 });
    expect((await request(app).get('/thing')).status).toBe(200);
    expect((await request(app).get('/thing')).status).toBe(200);
  });
});

describe('auth endpoint limits (wired into the app)', () => {
  it('limits auth requests per client IP (RATE_LIMIT_AUTH_PER_MINUTE = 20)', async () => {
    const app = createApp();
    const send = () =>
      request(app).post('/api/auth/register').set('x-forwarded-for', '203.0.113.7').send({});
    for (let i = 0; i < 20; i += 1) expect((await send()).status).toBe(422);
    expect((await send()).status).toBe(429);

    // A different client is unaffected.
    const other = await request(app)
      .post('/api/auth/register')
      .set('x-forwarded-for', '203.0.113.8')
      .send({});
    expect(other.status).toBe(422);
  });

  it('limits login attempts per email even across many IPs (RATE_LIMIT_LOGIN_PER_EMAIL = 10)', async () => {
    const app = createApp();
    const attempt = (i) =>
      request(app)
        .post('/api/auth/login')
        .set('x-forwarded-for', `198.51.100.${i}`)
        .send({ email: ' Victim@Example.com ', password: `guess-${i}` });
    for (let i = 1; i <= 10; i += 1) expect((await attempt(i)).status).toBe(401);
    expect((await attempt(11)).status).toBe(429);
  });
});

describe('login timing', () => {
  it('spends a bcrypt comparison even when the email does not exist', async () => {
    passwordService.verifyAgainstDummyHash.mockClear();
    const res = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever-password' });
    expect(res.status).toBe(401);
    expect(passwordService.verifyAgainstDummyHash).toHaveBeenCalledTimes(1);
  });
});

describe('CSRF: trusted origin on cookie-authenticated routes', () => {
  const app = createApp();

  it('refuses a POST from a foreign origin', async () => {
    const res = await request(app).post('/api/auth/refresh').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets our own origin and non-browser clients (no Origin) through', async () => {
    // 401 = reached the handler, which wants a refresh cookie.
    expect((await request(app).post('/api/auth/refresh').set('Origin', CLIENT_ORIGIN)).status).toBe(
      401,
    );
    expect((await request(app).post('/api/auth/refresh')).status).toBe(401);
  });
});

describe('response hardening', () => {
  it('marks API responses as not cacheable', async () => {
    const res = await request(createApp()).get('/api/documents');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('password rules', () => {
  const base = { name: 'A', email: 'a@example.com' };

  it('accepts 72 bytes and refuses 73, counting bytes not characters', () => {
    expect(registerSchema.safeParse({ ...base, password: 'a'.repeat(72) }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, password: 'a'.repeat(73) }).success).toBe(false);
    // 18 emoji = 18 characters but 72 bytes; 19 emoji = 76 bytes.
    expect(registerSchema.safeParse({ ...base, password: '😀'.repeat(18) }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, password: '😀'.repeat(19) }).success).toBe(false);
  });
});

describe('token bucket', () => {
  it('allows a burst, then the sustained rate', () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 2, now: () => now });
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now += 500; // half a second at 2/s = one token
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });
});

describe('client IP behind proxies', () => {
  const req = (forwarded, remote = '10.0.0.2') => ({
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    socket: { remoteAddress: remote },
  });

  it('uses the entry the trusted proxy added, not ones the client could forge', () => {
    // The client claims 1.2.3.4; Nginx appended the real address 203.0.113.9.
    expect(clientIpOf(req('1.2.3.4, 203.0.113.9'), 1)).toBe('203.0.113.9');
    expect(clientIpOf(req('1.2.3.4, 203.0.113.9'), 2)).toBe('1.2.3.4');
  });

  it('uses the socket address when no proxy is trusted or none forwarded', () => {
    expect(clientIpOf(req('1.2.3.4'), 0)).toBe('10.0.0.2');
    expect(clientIpOf(req(undefined), 1)).toBe('10.0.0.2');
  });
});
