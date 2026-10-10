import * as memberService from '../services/member.service.js';
import {
  documentIdSchema,
  inviteMemberSchema,
  updateMemberSchema,
} from '../utils/document.schemas.js';
import { AppError } from '../utils/app-error.js';

/** Malformed ids name nothing: 404 before anything reaches PostgreSQL. */
function idsFrom(req) {
  const documentId = documentIdSchema.safeParse(req.params.id);
  if (!documentId.success) throw AppError.notFound('Document not found');
  if (req.params.userId === undefined) return { documentId: documentId.data };
  const userId = documentIdSchema.safeParse(req.params.userId);
  if (!userId.success) throw AppError.notFound('Member not found');
  return { documentId: documentId.data, userId: userId.data };
}

/** GET /api/documents/:id/members */
export async function listMembers(req, res) {
  const { documentId } = idsFrom(req);
  res.status(200).json({ members: await memberService.listMembers(req.user.id, documentId) });
}

/** POST /api/documents/:id/members  { email, role } */
export async function addMember(req, res) {
  const { documentId } = idsFrom(req);
  const data = inviteMemberSchema.parse(req.body);
  res.status(201).json({ member: await memberService.addMember(req.user.id, documentId, data) });
}

/** PATCH /api/documents/:id/members/:userId  { role } */
export async function updateMember(req, res) {
  const { documentId, userId } = idsFrom(req);
  const { role } = updateMemberSchema.parse(req.body);
  const member = await memberService.changeMemberRole(
    req.app.locals.hub,
    req.user.id,
    documentId,
    userId,
    role,
  );
  res.status(200).json({ member });
}

/** DELETE /api/documents/:id/members/:userId — removing someone, or leaving. */
export async function removeMember(req, res) {
  const { documentId, userId } = idsFrom(req);
  await memberService.removeMember(req.app.locals.hub, req.user.id, documentId, userId);
  res.status(204).end();
}
