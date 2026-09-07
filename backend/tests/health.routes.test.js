import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { isApiErrorResponse } from '@collab/shared';
import { createApp } from '../src/app.js';

const app = createApp();

describe('GET /healthz', () => {
  it('reports liveness without touching dependencies', async () => {
    const response = await request(app).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'collab-editor-backend',
      version: '0.1.0',
    });
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(Date.parse(response.body.timestamp)).not.toBeNaN();
  });

  it('reuses a well-formed inbound request id so one id spans proxy and instance', async () => {
    const response = await request(app).get('/healthz').set('x-request-id', 'trace-abc-12345');

    expect(response.headers['x-request-id']).toBe('trace-abc-12345');
  });

  // Node's HTTP client refuses to transmit a header containing a newline, so the
  // log-injection case is unit-tested directly against resolveRequestId in
  // request-id.test.js. Here we assert the end-to-end behaviour with a malformed
  // value that is actually sendable.
  it('replaces a malformed inbound request id instead of trusting it', async () => {
    const response = await request(app).get('/healthz').set('x-request-id', 'bad id!');

    expect(response.headers['x-request-id']).not.toBe('bad id!');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('unknown routes', () => {
  it('answers with the shared error envelope and a correlating request id', async () => {
    const response = await request(app).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(isApiErrorResponse(response.body)).toBe(true);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });
});

describe('request size limits', () => {
  it('rejects an oversized JSON body with 413 before it reaches a route', async () => {
    const oversized = JSON.stringify({ payload: 'x'.repeat(200 * 1024) });

    const response = await request(app)
      .post('/api/anything')
      .set('content-type', 'application/json')
      .send(oversized);

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects a malformed JSON body with 400', async () => {
    const response = await request(app)
      .post('/api/anything')
      .set('content-type', 'application/json')
      .send('{"unterminated":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('security headers', () => {
  it('applies helmet defaults and hides the framework', async () => {
    const response = await request(app).get('/healthz');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });
});
