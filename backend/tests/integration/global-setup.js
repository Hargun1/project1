import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { assertTestDatabase, assertTestRedis, DATABASE_URL, REDIS_URL } from './config.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const NOT_RUNNING =
  'Integration tests need PostgreSQL and Redis. Start them with `npm run infra:up` ' +
  '(or set INTEGRATION_DATABASE_URL / INTEGRATION_REDIS_URL).';

/**
 * Runs once, before any test file: create the test database if needed, apply
 * every migration with `prisma migrate deploy` (exactly what a deployment does),
 * and check that Redis answers. Fails fast with one readable message.
 */
export default async function setup() {
  const databaseName = assertTestDatabase(DATABASE_URL);
  assertTestRedis(REDIS_URL);

  // CREATE DATABASE cannot run inside the target database, so connect to the
  // server's maintenance database for it.
  const maintenanceUrl = new URL(DATABASE_URL);
  maintenanceUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl.toString() });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  } catch (err) {
    if (!/already exists/i.test(err.message)) {
      throw new Error(`${NOT_RUNNING}\n${err.message}`);
    }
  } finally {
    await admin.$disconnect();
  }

  execSync('npx prisma migrate deploy', {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL },
    stdio: 'pipe',
  });

  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(`${NOT_RUNNING}\n${err.message}`);
  } finally {
    redis.disconnect();
  }
}
