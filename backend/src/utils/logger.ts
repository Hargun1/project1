import pino from 'pino';
import { env, isProduction } from '../config/env';
import { SERVICE_NAME } from '../config/constants';

/**
 * Structured logging (§29).
 *
 * `redact` is the enforcement of "never log passwords, tokens or secrets" — it
 * strips those paths even when a future caller logs a whole request or user
 * object by accident.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: SERVICE_NAME },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'token',
      '*.token',
      'accessToken',
      '*.accessToken',
      'refreshToken',
      '*.refreshToken',
      'ticket',
      '*.ticket',
    ],
    remove: true,
  },
  // Human-readable in development, newline-delimited JSON everywhere else.
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      },
});

export type Logger = typeof logger;
