import { z } from 'zod';

/**
 * The environment contract, validated once at startup.
 *
 * `process.env` is `string | undefined` at runtime no matter what any type
 * declaration claims, so Zod — not the language — is what stops the process from
 * booting with a missing secret and failing later inside a request handler.
 * With the TypeScript layer gone this schema is the *only* description of the
 * environment the app requires, which makes keeping it accurate more important,
 * not less.
 *
 * Unknown keys are stripped: the root `.env` also carries POSTGRES_*, REDIS_PORT
 * and VITE_* variables that belong to docker compose and Vite, not to the server.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

const secret = (label) =>
  z.string().min(32, `${label} must be at least 32 characters (generate: openssl rand -base64 48)`);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(4000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

    CLIENT_URL: z.string().url('CLIENT_URL must be an absolute URL, e.g. http://localhost:5173'),

    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
        'DATABASE_URL must be a postgresql:// connection string',
      ),

    REDIS_URL: z
      .string()
      .min(1)
      .refine(
        (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
        'REDIS_URL must be a redis:// connection string',
      ),

    JWT_SECRET: secret('JWT_SECRET'),
    JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),

    /** Lifetime of a single-use WebSocket connection ticket (Phase 5). */
    WS_TICKET_TTL_SECONDS: z.coerce.number().int().positive().max(300).default(30),
    /** Idle window before a Y.Doc snapshot is persisted (Phase 9). */
    DOC_SNAPSHOT_DEBOUNCE_MS: z.coerce.number().int().positive().max(60_000).default(2_000),
    /** Hard cap on a single document's Yjs state (Phase 11). */
    MAX_DOCUMENT_SIZE_BYTES: z.coerce.number().int().positive().default(1_048_576),

    /** Refresh session TTL in Redis, in seconds. Defaults to 7 days. */
    REFRESH_TOKEN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(604_800),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_SECRET',
      });
    }

    if (env.NODE_ENV === 'production') {
      for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
        if (env[key].includes('change-me')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} still holds the development placeholder; set a real secret in production`,
          });
        }
      }
    }
  });

/**
 * Throws a `ZodError` listing every problem at once.
 *
 * @param {Record<string, string | undefined>} source usually `process.env`
 * @returns {object} the parsed, defaulted, coerced environment
 */                              
export function parseEnv(source) {
  return envSchema.parse(source);
}

/**
 * Renders a `ZodError` as one readable line per offending variable.
 *
 * @param {import('zod').ZodError} error
 * @returns {string}
 */
export function formatEnvIssues(error) {
  return error.issues
    .map((issue) => {
      const variable = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${variable}: ${issue.message}`;
    })
    .join('\n');
}
