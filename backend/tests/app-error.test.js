import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '@collab/shared';
import { AppError } from '../src/utils/app-error.js';

/**
 * These tests exist because the type checker used to do this job. `code` was a
 * union type, so a typo was a compile error; now only the constructor's runtime
 * check catches it.
 */
describe('AppError', () => {
  it('rejects a code that is not in the shared list', () => {
    expect(
      () => new AppError({ status: 404, code: 'NOT_FOUNND', message: 'typo in the code' }),
    ).toThrow(/unknown code/);
  });

  it('rejects a non-string code', () => {
    expect(() => new AppError({ status: 500, code: undefined, message: 'no code' })).toThrow(
      TypeError,
    );
  });

  it('emits only codes the shared list defines, from every factory', () => {
    const built = [
      AppError.validation(),
      AppError.badRequest('bad'),
      AppError.unauthenticated(),
      AppError.forbidden(),
      AppError.notFound(),
      AppError.conflict('conflict'),
      AppError.payloadTooLarge(),
      AppError.rateLimited(),
      AppError.internal(),
    ];

    for (const error of built) {
      expect(API_ERROR_CODES).toContain(error.code);
    }
  });

  it('exposes 4xx messages to the client but withholds 5xx ones', () => {
    expect(AppError.notFound('no such document').expose).toBe(true);
    expect(AppError.internal('connection string was rejected by postgres').expose).toBe(false);
  });

  it('preserves the underlying cause for the log without exposing it', () => {
    const cause = new Error('SELECT failed: relation "users" does not exist');
    const error = AppError.internal('Internal server error', cause);

    expect(error.cause).toBe(cause);
    expect(error.expose).toBe(false);
  });

  it('is catchable as an Error and identifies itself by name', () => {
    const error = AppError.forbidden();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.status).toBe(403);
  });
});
