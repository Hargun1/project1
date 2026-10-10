/**
 * Per-worker environment for integration tests: the unit-test defaults, pointed
 * at the real (test) PostgreSQL database and Redis database.
 */
import '../setup.js';
import { DATABASE_URL, REDIS_URL } from './config.js';

process.env.DATABASE_URL = DATABASE_URL;
process.env.REDIS_URL = REDIS_URL;
