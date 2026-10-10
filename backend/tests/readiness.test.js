import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * /readyz decides whether a load balancer sends this instance traffic, so each
 * state is pinned: ready, degraded (a dependency is down) and draining (graceful
 * shutdown has begun, Phase 12). The dependency checks are mocked; the real ones
 * are exercised end to end against the Docker stack.
 */

const deps = vi.hoisted(() => ({ database: true, redis: true }));

vi.mock('../src/database/prisma.js', async (importOriginal) => ({
  ...(await importOriginal()),
  checkDatabaseConnection: vi.fn(async () => deps.database),
}));
vi.mock('../src/redis/redis.js', async (importOriginal) => ({
  ...(await importOriginal()),
  checkRedisConnection: vi.fn(async () => deps.redis),
}));

const { createApp } = await import('../src/app.js');

beforeEach(() => {
  deps.database = true;
  deps.redis = true;
});

describe('GET /readyz', () => {
  it('is 200 ready when every dependency is up', async () => {
    const response = await request(createApp()).get('/readyz');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ready',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('is 503 degraded, naming the dependency, when one is down', async () => {
    deps.redis = false;
    const response = await request(createApp()).get('/readyz');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'degraded',
      checks: { database: 'up', redis: 'down' },
    });
  });

  it('is 503 draining once shutdown has begun, even with healthy dependencies', async () => {
    const app = createApp();
    app.locals.draining = true;

    const readiness = await request(app).get('/readyz');
    expect(readiness.status).toBe(503);
    expect(readiness.body.status).toBe('draining');

    // Liveness is unaffected: the process is alive and finishing its work.
    expect((await request(app).get('/healthz')).status).toBe(200);
  });
});
