import { describe, it, expect } from 'vitest';
import { registerSchema, loginSchema } from '../src/auth/auth.schemas.js';

describe('registerSchema', () => {
  it('accepts valid input', () => {
    const result = registerSchema.safeParse({
      name: 'Hargun',
      email: 'hargun@example.com',
      password: 'securepass123',
    });
    expect(result.success).toBe(true);
    expect(result.data.email).toBe('hargun@example.com');
  });

  it('trims and lowercases email', () => {
    const result = registerSchema.safeParse({
      name: 'Test',
      email: '  USER@Example.COM  ',
      password: 'securepass123',
    });
    expect(result.success).toBe(true);
    expect(result.data.email).toBe('user@example.com');
  });

  it('trims name', () => {
    const result = registerSchema.safeParse({
      name: '  Spaced Name  ',
      email: 'a@b.com',
      password: 'securepass123',
    });
    expect(result.success).toBe(true);
    expect(result.data.name).toBe('Spaced Name');
  });

  it('rejects missing name', () => {
    const result = registerSchema.safeParse({
      email: 'a@b.com',
      password: 'securepass123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = registerSchema.safeParse({
      name: '   ',
      email: 'a@b.com',
      password: 'securepass123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name longer than 100 characters', () => {
    const result = registerSchema.safeParse({
      name: 'x'.repeat(101),
      email: 'a@b.com',
      password: 'securepass123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email', () => {
    const result = registerSchema.safeParse({
      name: 'Test',
      email: 'not-an-email',
      password: 'securepass123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing email', () => {
    const result = registerSchema.safeParse({
      name: 'Test',
      password: 'securepass123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects short password', () => {
    const result = registerSchema.safeParse({
      name: 'Test',
      email: 'a@b.com',
      password: 'short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing password', () => {
    const result = registerSchema.safeParse({
      name: 'Test',
      email: 'a@b.com',
    });
    expect(result.success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('accepts valid input', () => {
    const result = loginSchema.safeParse({
      email: 'hargun@example.com',
      password: 'mypassword',
    });
    expect(result.success).toBe(true);
  });

  it('trims and lowercases email', () => {
    const result = loginSchema.safeParse({
      email: '  USER@Example.COM  ',
      password: 'mypassword',
    });
    expect(result.success).toBe(true);
    expect(result.data.email).toBe('user@example.com');
  });

  it('rejects missing email', () => {
    const result = loginSchema.safeParse({ password: 'mypassword' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email', () => {
    const result = loginSchema.safeParse({
      email: 'bad',
      password: 'mypassword',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty password', () => {
    const result = loginSchema.safeParse({
      email: 'a@b.com',
      password: '',
    });
    expect(result.success).toBe(false);
  });
});
