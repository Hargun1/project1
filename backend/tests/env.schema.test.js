import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { formatEnvIssues, parseEnv } from '../src/config/env.schema.js';

const validEnv = {
  NODE_ENV: 'development',
  PORT: '4000',
  CLIENT_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://collab:collab@localhost:5432/collab_editor?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
};

describe('env schema', () => {
  it('accepts a valid environment and applies defaults', () => {
    const env = parseEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.WS_TICKET_TTL_SECONDS).toBe(30);
    expect(env.DOC_SNAPSHOT_DEBOUNCE_MS).toBe(2_000);
    expect(env.MAX_DOCUMENT_SIZE_BYTES).toBe(1_048_576);
  });

  it('coerces numeric variables from strings', () => {
    const env = parseEnv({ ...validEnv, PORT: '8080', DOC_SNAPSHOT_DEBOUNCE_MS: '750' });

    expect(env.PORT).toBe(8080);
    expect(env.DOC_SNAPSHOT_DEBOUNCE_MS).toBe(750);
  });

  it('strips variables that belong to compose or Vite rather than the server', () => {
    const env = parseEnv({ ...validEnv, POSTGRES_PASSWORD: 'secret', VITE_API_BASE_URL: '' });

    expect(env).not.toHaveProperty('POSTGRES_PASSWORD');
    expect(env).not.toHaveProperty('VITE_API_BASE_URL');
  });

  it('rejects a missing required variable', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabaseUrl } = validEnv;

    expect(() => parseEnv(withoutDatabaseUrl)).toThrow(ZodError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => parseEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost:3306/db' })).toThrow(
      /postgresql:\/\//,
    );
  });

  it('rejects a secret shorter than 32 characters', () => {
    expect(() => parseEnv({ ...validEnv, JWT_SECRET: 'too-short' })).toThrow(/at least 32/);
  });

  it('rejects identical access and refresh secrets', () => {
    const secret = 'c'.repeat(40);

    expect(() => parseEnv({ ...validEnv, JWT_SECRET: secret, JWT_REFRESH_SECRET: secret })).toThrow(
      /must differ/,
    );
  });

  it('rejects placeholder secrets in production', () => {
    expect(() =>
      parseEnv({
        ...validEnv,
        NODE_ENV: 'production',
        JWT_SECRET: `change-me-${'x'.repeat(30)}`,
      }),
    ).toThrow(/placeholder/);
  });

  it('reports every offending variable at once', () => {
    try {
      parseEnv({ ...validEnv, CLIENT_URL: 'not-a-url', JWT_SECRET: 'short' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      const formatted = formatEnvIssues(error);
      expect(formatted).toContain('CLIENT_URL');
      expect(formatted).toContain('JWT_SECRET');
    }
  });
});
