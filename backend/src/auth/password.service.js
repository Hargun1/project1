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

let dummyHashPromise = null;

function dummyHash() {
  dummyHashPromise ??= bcrypt.hash('timing-equaliser-not-a-real-password', SALT_ROUNDS);
  return dummyHashPromise;
}

/**
 * Create the dummy hash at startup. If it were created lazily, the *first*
 * unknown-email login after each restart would pay for a hash *and* a
 * comparison (twice as slow) and leak once. Measured: 603 ms vs 322 ms before
 * this was added. Called from server.js.
 *
 * @returns {Promise<void>}
 */
export async function warmUpPasswordHashing() {
  await dummyHash();
}

/**
 * Spend the same time as a real password check, for a login with an unknown
 * email, so response time does not reveal which emails have accounts. The
 * result is always ignored.
 *
 * @param {string} plaintext
 * @returns {Promise<void>}
 */
export async function verifyAgainstDummyHash(plaintext) {
  await bcrypt.compare(plaintext, await dummyHash());
}
