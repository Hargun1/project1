import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } from '../src/auth/token.service.js';

const MOCK_USER = { id: '550e8400-e29b-41d4-a716-446655440000', email: 'test@example.com', name: 'Test User' };

describe('token.service', () => {
  describe('access token', () => {
    it('generates and verifies a valid token', () => {
      const token = generateAccessToken(MOCK_USER);
      expect(typeof token).toBe('string');

      const decoded = verifyAccessToken(token);
      expect(decoded.sub).toBe(MOCK_USER.id);
      expect(decoded.email).toBe(MOCK_USER.email);
      expect(decoded.name).toBe(MOCK_USER.name);
    });

    it('rejects a token signed with a different secret', () => {
      const token = jwt.sign({ sub: MOCK_USER.id }, 'wrong-secret-that-is-at-least-32-chars');
      expect(() => verifyAccessToken(token)).toThrow();
    });

    it('rejects an expired token', () => {
      const token = jwt.sign(
        { sub: MOCK_USER.id },
        process.env.JWT_SECRET,
        { expiresIn: '0s' },
      );
      expect(() => verifyAccessToken(token)).toThrow();
    });
  });

  describe('refresh token', () => {
    it('generates a token with a jti', () => {
      const { token, jti } = generateRefreshToken(MOCK_USER);
      expect(typeof token).toBe('string');
      expect(typeof jti).toBe('string');
      expect(jti.length).toBeGreaterThan(0);

      const decoded = verifyRefreshToken(token);
      expect(decoded.sub).toBe(MOCK_USER.id);
      expect(decoded.jti).toBe(jti);
    });

    it('rejects a token signed with the access secret', () => {
      const token = jwt.sign(
        { sub: MOCK_USER.id, jti: 'fake' },
        process.env.JWT_SECRET, // wrong: using access secret for refresh
        { expiresIn: '7d' },
      );
      expect(() => verifyRefreshToken(token)).toThrow();
    });
  });
});
