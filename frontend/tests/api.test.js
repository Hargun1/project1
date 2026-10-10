import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError, NETWORK_ERROR } from '../src/services/api.js';

/**
 * The single HTTP client (Phase 13): every failure becomes an ApiError with a
 * code the pages can branch on — including errors that never came from the
 * backend (network down, Nginx with no backend behind it).
 */

let fetchMock;

function respond(status, body, contentType = 'application/json') {
  fetchMock.mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    }),
  );
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the request to fail');
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch', () => {
  it('returns the parsed body and sends cookies (the refresh token is one)', async () => {
    respond(200, { ok: true });
    expect(await apiFetch('/api/thing')).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/thing');
    expect(init.credentials).toBe('include');
    expect(init.headers.Accept).toBe('application/json');
  });

  it('turns the error envelope into an ApiError with code, message and request id', async () => {
    respond(403, {
      error: { code: 'FORBIDDEN', message: 'Viewers cannot edit', requestId: 'req-123' },
    });
    const err = await failure(apiFetch('/api/thing'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Viewers cannot edit',
      requestId: 'req-123',
    });
  });

  it('understands the JSON 503 that Nginx sends when no backend is up', async () => {
    respond(503, {
      error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable.' },
    });
    const err = await failure(apiFetch('/api/thing'));
    expect(err).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('does not trust a body that is not the envelope (e.g. an HTML error page)', async () => {
    respond(502, '<html>Bad Gateway</html>', 'text/html');
    const err = await failure(apiFetch('/api/thing'));
    expect(err).toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });

    respond(500, { error: { code: 'MADE_UP_CODE', message: 'x' } });
    expect(await failure(apiFetch('/api/thing'))).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('reports a request that never reached a server as NETWORK_ERROR with status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const err = await failure(apiFetch('/api/thing'));
    expect(err).toMatchObject({ status: 0, code: NETWORK_ERROR });
  });

  it('accepts listed non-2xx statuses as data (a degraded /readyz is a valid answer)', async () => {
    respond(503, { status: 'degraded', checks: { database: 'up', redis: 'down' } });
    expect(await apiFetch('/readyz', { allowStatuses: [503] })).toMatchObject({
      status: 'degraded',
    });
  });
});
