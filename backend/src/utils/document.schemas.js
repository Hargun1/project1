import { z } from 'zod';

export const createDocumentSchema = z.object({
  name: z.string().min(1).max(255),
  language: z.string().min(1).max(32),
});

export const updateDocumentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  language: z.string().min(1).max(32).optional(),
});

export const listDocumentsSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  language: z.string().optional(),
});

/** Phase 4: plain-text save. Capped at 500 KB until Phase 11 adds formal limits. */
export const saveContentSchema = z.object({
  content: z.string().max(512_000),
});
