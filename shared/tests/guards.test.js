import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  DEPENDENCY_STATES,
  ROLES,
  isApiErrorCode,
  isApiErrorResponse,
  isDependencyState,
  isRole,
} from '../src/index.js';

/**
 * With no compiler, these guards are the entire contract enforcement between the
 * browser and the server. Every one of them is on a path where a wrong answer is
 * a real bug — `isRole` gates authorization decisions, `isApiErrorResponse`
 * decides whether the client trusts an error body — so they are tested against
 * hostile input, not just happy paths.
 */

describe('isRole', () => {
  it('accepts every declared role', () => {
    for (const role of ROLES) {
      expect(isRole(role)).toBe(true);
    }
  });

  it('declares roles in descending privilege order', () => {
    expect(ROLES).toEqual(['OWNER', 'EDITOR', 'VIEWER']);
  });

  it.each([
    ['lowercase', 'owner'],
    ['trailing space', 'OWNER '],
    ['unknown role', 'ADMIN'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 1],
    ['object', { role: 'OWNER' }],
  ])('rejects %s', (_label, value) => {
    expect(isRole(value)).toBe(false);
  });

  it('rejects inherited Array members so a crafted string cannot pass', () => {
    // `includes` is a value check, not a property lookup — guards against the
    // classic `'constructor'`/`'toString'` style bypass.
    expect(isRole('constructor')).toBe(false);
    expect(isRole('toString')).toBe(false);
  });
});

describe('isApiErrorCode', () => {
  it('accepts every declared code', () => {
    for (const code of API_ERROR_CODES) {
      expect(isApiErrorCode(code)).toBe(true);
    }
  });

  it.each([
    ['unknown code', 'TEAPOT'],
    ['lowercase', 'not_found'],
    ['empty string', ''],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isApiErrorCode(value)).toBe(false);
  });
});

describe('isDependencyState', () => {
  it('accepts every declared state', () => {
    for (const state of DEPENDENCY_STATES) {
      expect(isDependencyState(state)).toBe(true);
    }
  });

  it('distinguishes not_configured from down', () => {
    // Different meanings: "we never wired this up" vs "wired up and unreachable".
    expect(DEPENDENCY_STATES).toContain('not_configured');
    expect(DEPENDENCY_STATES).toContain('down');
  });

  it.each([
    ['unknown state', 'degraded'],
    ['null', null],
    ['boolean', true],
  ])('rejects %s', (_label, value) => {
    expect(isDependencyState(value)).toBe(false);
  });
});

describe('isApiErrorResponse', () => {
  it('accepts a minimal valid envelope', () => {
    expect(isApiErrorResponse({ error: { code: 'NOT_FOUND', message: 'nope' } })).toBe(true);
  });

  it('accepts an envelope carrying details and a request id', () => {
    expect(
      isApiErrorResponse({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: [{ path: 'email', message: 'Invalid email' }],
          requestId: 'e6b1c0f4-1f2a-4c1d-9a44-3f0d2c9b7a11',
        },
      }),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'error'],
    ['an array', []],
    ['no error key', { message: 'nope' }],
    ['error is null', { error: null }],
    ['error is a string', { error: 'boom' }],
    ['missing message', { error: { code: 'NOT_FOUND' } }],
    ['missing code', { error: { message: 'nope' } }],
    ['unknown code', { error: { code: 'TEAPOT', message: 'nope' } }],
    ['non-string message', { error: { code: 'NOT_FOUND', message: 42 } }],
  ])('rejects %s', (_label, value) => {
    expect(isApiErrorResponse(value)).toBe(false);
  });

  it('rejects an HTML error page from a proxy rather than reading it as an envelope', () => {
    // The realistic failure: Nginx answers 502 with HTML, not JSON. The client
    // must fall through to its generic message instead of destructuring nothing.
    expect(isApiErrorResponse('<html><body>502 Bad Gateway</body></html>')).toBe(false);
  });
});
