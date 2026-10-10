import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import {
  api,
  CLIENT_ORIGIN,
  PASSWORD,
  prisma,
  redis,
  refreshCookieOf,
  registerUser,
  startInstance,
  useIntegrationStack,
} from './stack.js';

/**
 * Authentication against real PostgreSQL (users) and Redis (refresh sessions,
 * rate-limit counters). Spec §38: register, login, invalid and expired tokens,
 * rate limits.
 */

useIntegrationStack();

/** The full Set-Cookie line for the refresh cookie (attributes included). */
const refreshSetCookie = (res) =>
  (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('collab_refresh='));

describe('registration and login', () => {
  it('stores a bcrypt hash (never the password), a normalised email and a refresh session', async () => {
    const a = await startInstance('a');
    const res = await request(a.server)
      .post('/api/auth/register')
      .set('Origin', CLIENT_ORIGIN)
      .send({ name: 'Ada', email: '  Ada@Example.TEST ', password: PASSWORD });

    expect(res.status).toBe(201);
    const row = await prisma.user.findUnique({ where: { email: 'ada@example.test' } });
    expect(row).not.toBeNull();
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);

    const cookie = refreshSetCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(await redis.keys('refresh:*')).toHaveLength(1);
  });

  it('refuses a second account for the same email, whatever its case', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const res = await request(a.server)
      .post('/api/auth/register')
      .set('Origin', CLIENT_ORIGIN)
      .send({ name: 'Imposter', email: ada.email.toUpperCase(), password: PASSWORD });

    expect(res.status).toBe(409);
    expect(await prisma.user.count()).toBe(1);
  });

  it('answers two simultaneous registrations for one email with 201 and 409, never 500', async () => {
    const a = await startInstance('a');
    const body = { name: 'Twin', email: 'twin@example.test', password: PASSWORD };
    const register = () =>
      request(a.server).post('/api/auth/register').set('Origin', CLIENT_ORIGIN).send(body);

    const statuses = (await Promise.all([register(), register()])).map((r) => r.status).sort();

    expect(statuses).toEqual([201, 409]);
    expect(await prisma.user.count()).toBe(1);
  });

  it('logs in with the right password only, and /me returns the user', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const login = (password) =>
      request(a.server)
        .post('/api/auth/login')
        .set('Origin', CLIENT_ORIGIN)
        .send({ email: ada.email, password });

    expect((await login('wrong-password-123')).status).toBe(401);
    const ok = await login(PASSWORD);
    expect(ok.status).toBe(200);

    const me = await api(a, { token: ok.body.accessToken }).get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: ada.id, email: ada.email });
    expect(me.body.user).not.toHaveProperty('passwordHash');
  });
});

describe('refresh tokens', () => {
  it('rotate: each refresh token works once, and a replayed one is refused', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const original = ada.refreshCookie;

    const first = await request(a.server)
      .post('/api/auth/refresh')
      .set('Origin', CLIENT_ORIGIN)
      .set('Cookie', original);
    expect(first.status).toBe(200);
    expect(typeof first.body.accessToken).toBe('string');

    // The same cookie again: its session was consumed (GETDEL) by the first refresh.
    const replay = await request(a.server)
      .post('/api/auth/refresh')
      .set('Origin', CLIENT_ORIGIN)
      .set('Cookie', original);
    expect(replay.status).toBe(401);

    // The rotated cookie works.
    const rotated = refreshCookieOf(first);
    const next = await request(a.server)
      .post('/api/auth/refresh')
      .set('Origin', CLIENT_ORIGIN)
      .set('Cookie', rotated);
    expect(next.status).toBe(200);
  });

  it('stop working after logout', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');

    expect((await ada.agent.post('/api/auth/logout').set('Origin', CLIENT_ORIGIN)).status).toBe(
      204,
    );
    const res = await ada.agent.post('/api/auth/refresh').set('Origin', CLIENT_ORIGIN);
    expect(res.status).toBe(401);
  });

  it('are shared by all instances: refresh on one, replay on another is refused', async () => {
    const a = await startInstance('a');
    const b = await startInstance('b');
    const ada = await registerUser(a, 'Ada');
    const cookie = ada.refreshCookie;
    const refresh = (instance) =>
      request(instance.server)
        .post('/api/auth/refresh')
        .set('Origin', CLIENT_ORIGIN)
        .set('Cookie', cookie);

    expect((await refresh(b)).status).toBe(200);
    expect((await refresh(a)).status).toBe(401);
  });
});

describe('access tokens', () => {
  it('rejects a missing, malformed, expired or wrongly signed token', async () => {
    const a = await startInstance('a');
    const ada = await registerUser(a, 'Ada');
    const claims = { sub: ada.id, email: ada.email, name: ada.name };
    const expired = jwt.sign(
      { ...claims, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET,
    );
    // A refresh-secret token must never pass as an access token.
    const otherSecret = jwt.sign(claims, process.env.JWT_REFRESH_SECRET, { expiresIn: '15m' });

    const docs = (token) => api(a, token ? { token } : null).get('/api/documents');
    expect((await docs(null)).status).toBe(401);
    expect((await docs('not.a.jwt')).status).toBe(401);
    expect((await docs(expired)).status).toBe(401);
    expect((await docs(otherSecret)).status).toBe(401);
    expect((await docs(ada.token)).status).toBe(200);
  });
});

describe('rate limits in Redis', () => {
  it('count login attempts per email across instances (RATE_LIMIT_LOGIN_PER_EMAIL = 10)', async () => {
    const a = await startInstance('a');
    const b = await startInstance('b');
    const ada = await registerUser(a, 'Ada');

    const statuses = [];
    for (let i = 0; i < 11; i += 1) {
      const instance = i % 2 ? b : a;
      const res = await request(instance.server)
        .post('/api/auth/login')
        .set('Origin', CLIENT_ORIGIN)
        .set('X-Forwarded-For', `198.51.100.${i + 1}`)
        .send({ email: ada.email, password: `wrong-${i}` });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    const ttl = await redis.pttl(`rl:login-email:${ada.email}`);
    expect(ttl).toBeGreaterThan(14 * 60_000); // a 15-minute window, set once
  });
});
