import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';

/**
 * Data-access layer for the `users` table.
 *
 * Nothing here makes business decisions — it wraps Prisma calls so the service
 * layer never touches the ORM directly (§4).
 */

/** Fields safe to return to the client (no passwordHash). */
const PUBLIC_SELECT = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * The unique index on `email` is the real guarantee of one account per address.
 * The service checks first to answer quickly, but two simultaneous sign-ups
 * both pass that check (bcrypt takes ~250 ms in between); the second insert then
 * violates the index. That is reported as `null` and becomes a 409, not a 500
 * (found by the Phase 13 integration tests).
 *
 * @param {{ name: string, email: string, passwordHash: string }} data
 * @returns {Promise<object | null>} the created user (public fields only), or
 *   null if the email is already taken
 */
export async function createUser(data) {
  try {
    return await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash: data.passwordHash,
      },
      select: PUBLIC_SELECT,
    });
  } catch (err) {
    // P2002 = unique constraint violation.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

/**
 * @param {string} email
 * @returns {Promise<object | null>} includes passwordHash — caller is responsible
 *   for NOT leaking it to the client.
 */
export async function findByEmail(email) {
  return prisma.user.findUnique({ where: { email } });
}

/**
 * @param {string} id
 * @returns {Promise<object | null>} public fields only
 */
export async function findById(id) {
  return prisma.user.findUnique({
    where: { id },
    select: PUBLIC_SELECT,
  });
}

/**
 * Look up a user to invite. Public fields only: unlike `findByEmail`, this is
 * used outside login, so it must never carry the password hash.
 *
 * @param {string} email  already normalised (trimmed, lower-case)
 * @returns {Promise<object | null>}
 */
export async function findPublicByEmail(email) {
  return prisma.user.findUnique({ where: { email }, select: PUBLIC_SELECT });
}
