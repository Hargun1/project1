import { describe, expect, it } from 'vitest';
import { resolveRequestId } from '../src/middleware/request-id.js';

describe('resolveRequestId', () => {
  it('keeps a well-formed inbound id', () => {
    expect(resolveRequestId('a1b2c3d4-e5f6')).toBe('a1b2c3d4-e5f6');
  });

  it('generates a uuid when the header is absent', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['too short', 'abc'],
    ['newline injection', 'valid-prefix\nlevel=fatal'],
    ['space', 'has space here'],
    ['empty', ''],
  ])('rejects %s and generates a fresh id instead', (_label, value) => {
    expect(resolveRequestId(value)).not.toBe(value);
    expect(resolveRequestId(value)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
