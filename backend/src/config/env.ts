import path from 'node:path';
import dotenv from 'dotenv';
import { ZodError } from 'zod';
import { formatEnvIssues, parseEnv, type Env } from './env.schema';

// One .env at the monorepo root serves the app, docker compose and Vite.
// Resolves identically from src/config (tsx) and dist/config (compiled output).
// Missing file is fine: in containers the values come from the environment.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function loadEnv(): Env {
  try {
    return parseEnv(process.env);
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

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
