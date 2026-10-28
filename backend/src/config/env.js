import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ZodError } from 'zod';
import { formatEnvIssues, parseEnv } from './env.schema.js';

// ES modules have no __dirname; derive it from import.meta.url instead.
const here = path.dirname(fileURLToPath(import.meta.url));

// One .env at the monorepo root serves the app, docker compose and Vite. There is
// no build step any more, so this path is always src/config → repository root.
// A missing file is fine: in containers the values come from the environment.
dotenv.config({ path: path.resolve(here, '../../../.env') });

function loadEnv() {
  try {
    return parseEnv({
      ...process.env,
      CLIENT_URL:
        process.env.CLIENT_URL ||
        (process.env.RENDER === 'true' ? process.env.RENDER_EXTERNAL_URL : undefined),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      // The logger is configured *from* env, so this is the one place that has to
      // write to stderr directly. Fail fast and name every offending variable.
      console.error(
        `\n✖ Invalid environment configuration:\n${formatEnvIssues(error)}\n\n` +
          `  Copy .env.example to .env at the repository root and fill it in.\n`,
      );
      process.exit(1);
    }
    throw error;
  }
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
