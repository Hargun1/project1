import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.service.js';

describe('password.service', () => {
  it('hashes a password and verifies it correctly', async () => {
    const plain = 'my-secure-password';
    const hash = await hashPassword(plain);

    // Hash should be a bcrypt string, not the plaintext.
    expect(hash).not.toBe(plain);
    expect(hash.startsWith('$2')).toBe(true);

    expect(await verifyPassword(plain, hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct-password');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('produces different hashes for the same input (salted)', async () => {
    const plain = 'same-password';
    const hash1 = await hashPassword(plain);
    const hash2 = await hashPassword(plain);
    expect(hash1).not.toBe(hash2); // different salts
  });
});
