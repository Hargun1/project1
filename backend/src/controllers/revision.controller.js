import { z } from 'zod';
import * as revisionService from '../services/revision.service.js';
import { AppError } from '../utils/app-error.js';

const uuid = z.string().uuid();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** A malformed id names no document or revision: 404, not a database cast error. */
function idsFrom(req) {
  const documentId = uuid.safeParse(req.params.id);
  if (!documentId.success) throw AppError.notFound('Document not found');
  if (req.params.revisionId === undefined) return { documentId: documentId.data };
  const revisionId = uuid.safeParse(req.params.revisionId);
  if (!revisionId.success) throw AppError.notFound('Revision not found');
  return { documentId: documentId.data, revisionId: revisionId.data };
}

/**
 * Restore and "save version" act on the live document, which only the
 * collaboration hub may touch.
 */
function hubOf(req) {
  const hub = req.app.locals.hub;
  if (!hub) throw AppError.internal('Collaboration hub is not configured');
  return hub;
}

/** GET /api/documents/:id/revisions — newest first, paginated. */
export async function listRevisions(req, res) {
  const { documentId } = idsFrom(req);
  const query = listQuerySchema.parse(req.query);
  res.status(200).json(await revisionService.listRevisions(req.user.id, documentId, query));
}

/** GET /api/documents/:id/revisions/:revisionId — includes the revision's text. */
export async function getRevision(req, res) {
  const { documentId, revisionId } = idsFrom(req);
  const revision = await revisionService.getRevision(req.user.id, documentId, revisionId);
  res.status(200).json({ revision });
}

/** POST /api/documents/:id/revisions — "Save version". 201 if new, 200 if unchanged. */
export async function createRevision(req, res) {
  const { documentId } = idsFrom(req);
  const result = await revisionService.createManualRevision(hubOf(req), req.user.id, documentId);
  res.status(result.created ? 201 : 200).json(result);
}

/** POST /api/documents/:id/revisions/:revisionId/restore — OWNER only. */
export async function restoreRevision(req, res) {
  const { documentId, revisionId } = idsFrom(req);
  const result = await revisionService.restoreRevision(
    hubOf(req),
    req.user.id,
    documentId,
    revisionId,
  );
  res.status(201).json(result);
}
