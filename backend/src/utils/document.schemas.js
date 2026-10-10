import { z } from 'zod';
import { ASSIGNABLE_ROLES } from '@collab/shared';

export const documentIdSchema = z.string().uuid();

export const createDocumentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  language: z.string().min(1).max(32),
});

export const updateDocumentSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  language: z.string().min(1).max(32).optional(),
});

export const listDocumentsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(255).optional(),
  language: z.string().max(32).optional(),
});

// ── Members (Phase 10) ──────────────────────────────────────────────────────

/** Roles an owner can grant; OWNER is deliberately not one of them. */
const assignableRole = z.enum(ASSIGNABLE_ROLES, {
  errorMap: () => ({ message: `Role must be one of ${ASSIGNABLE_ROLES.join(', ')}` }),
});

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  role: assignableRole,
});

export const updateMemberSchema = z.object({ role: assignableRole });
