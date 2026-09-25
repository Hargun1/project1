import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

/**
 * Hash a plaintext password with bcrypt.
 *
 * 12 rounds ≈ ~250 ms on a modern machine — slow enough to deter brute-force,
 * fast enough not to stall a request noticeably.
 *
 * @param {string} plaintext
 * @returns {Promise<string>} the bcrypt hash
 */
export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

/**
 * Verify a plaintext password against a stored bcrypt hash.
 *
 * @param {string} plaintext
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}
