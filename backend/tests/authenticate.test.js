import { describe, it, expect, vi } from 'vitest';
import { authenticate } from '../src/middleware/authenticate.js';
import { generateAccessToken } from '../src/auth/token.service.js';

function mockReq(headers = {}) {
  return {
    header: (name) => headers[name],
  };
}

function mockRes() {
  return {};
}

describe('authenticate middleware', () => {
  it('sets req.user for a valid token', () => {
    const token = generateAccessToken({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'test@example.com',
      name: 'Test User',
    });
    const req = mockReq({ Authorization: `Bearer ${token}` });
    const res = mockRes();
    const next = vi.fn();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeDefined();
    expect(req.user.id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(req.user.email).toBe('test@example.com');
    expect(req.user.name).toBe('Test User');
  });

  it('throws on missing Authorization header', () => {
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn();

    expect(() => authenticate(req, res, next)).toThrow();
    expect(next).not.toHaveBeenCalled();
  });

  it('throws on malformed Authorization header (no Bearer)', () => {
    const req = mockReq({ Authorization: 'Token abc123' });
    const res = mockRes();
    const next = vi.fn();

    expect(() => authenticate(req, res, next)).toThrow();
    expect(next).not.toHaveBeenCalled();
  });

  it('throws on invalid token', () => {
    const req = mockReq({ Authorization: 'Bearer not-a-valid-jwt' });
    const res = mockRes();
    const next = vi.fn();

    expect(() => authenticate(req, res, next)).toThrow();
    expect(next).not.toHaveBeenCalled();
  });
});
