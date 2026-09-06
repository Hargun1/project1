import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

/**
 * One PrismaClient per process — it owns the connection pool, so creating more
 * than one would multiply connections against PostgreSQL for no benefit.
 */
export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
});

prisma.$on('warn', (event) => logger.warn({ prisma: event }, 'prisma warning'));
prisma.$on('error', (event) => logger.error({ prisma: event }, 'prisma error'));

/** Readiness probe: a real round-trip, not just "is the client constructed". */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'PostgreSQL readiness check failed');
    return false;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
