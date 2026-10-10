import { z } from 'zod';
import { NAME_MAX_LENGTH, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from '@collab/shared';

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
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    // bcrypt only uses the first 72 BYTES of a password and silently ignores the
    // rest, so anything longer would give a false sense of strength. Bytes, not
    // characters: an emoji is 4 bytes in UTF-8 (Phase 11).
    .refine((value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES, {
      message: `Password must be at most ${PASSWORD_MAX_BYTES} bytes`,
    }),
});

export const loginSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .trim()
    .toLowerCase()
    .email('Invalid email address'),
  // Capped so an enormous body is never fed to bcrypt; generous for any real password.
  password: z
    .string({ required_error: 'Password is required' })
    .min(1, 'Password is required')
    .max(1_024, 'Password is too long'),
});
