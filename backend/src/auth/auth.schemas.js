import { z } from 'zod';
import { PASSWORD_MIN_LENGTH, NAME_MAX_LENGTH } from '@collab/shared';

/**
 * Zod schemas for authentication payloads (§10, §12).
 *
 * Every REST body hits one of these *before* it reaches business logic.
 * In plain JavaScript these are the only thing preventing malformed input from
 * reaching the database — there is no compiler to catch shape drift.
 */

export const registerSchema = z.object({
  name: z
    .string({ required_error: 'Name is required' })
    .trim()
    .min(1, 'Name is required')
    .max(NAME_MAX_LENGTH, `Name must be at most ${NAME_MAX_LENGTH} characters`),
  email: z
    .string({ required_error: 'Email is required' })
    .trim()
    .toLowerCase()
    .email('Invalid email address'),
  password: z
    .string({ required_error: 'Password is required' })
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`),
});

export const loginSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .trim()
    .toLowerCase()
    .email('Invalid email address'),
  password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required'),
});
