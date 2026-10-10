import * as memberRepo from '../repositories/member.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { AppError } from '../utils/app-error.js';
import { can } from '@collab/shared';
import { requireAccess, requirePermission } from './access.service.js';

/**
 * Member management (§15, §16): who can access a document, and with which role.
 *
 * Rules:
 *   - Every member may see the member list (you should know who can read your code).
 *   - Only the OWNER invites, changes roles and removes others.
 *   - Roles handed out are EDITOR or VIEWER. The owner's own role never changes,
 *     and the owner cannot be removed: a document always has exactly one owner.
 *   - Any non-owner may remove themselves ("leave").
 *
 * After a role change or removal, `hub.notifyAccessChanged` makes every backend
 * instance re-check that user's open sockets against the database, so the
 * change takes effect live (§42), not at their next reconnect.
 */

const MANAGE_ONLY = 'Only the owner can manage members';

export async function listMembers(actorId, documentId) {
  await requirePermission(actorId, documentId, 'document:read');
  return memberRepo.listMembers(documentId);
}

/**
 * Invite an existing account by email. (There is no email delivery: the person
 * must already have registered. Invitations by email are a future extension.)
 */
export async function addMember(actorId, documentId, { email, role }) {
  await requirePermission(actorId, documentId, 'members:manage', MANAGE_ONLY);

  const user = await userRepo.findPublicByEmail(email);
  if (!user) throw AppError.notFound('No account is registered with that email');

  if (await memberRepo.findMember(documentId, user.id)) {
    throw AppError.conflict('That person is already a member of this document');
  }
  const member = await memberRepo.addMember(documentId, user.id, role);
  // Two simultaneous invites: the primary key let only one through.
  if (!member) throw AppError.conflict('That person is already a member of this document');
  return member;
}

export async function changeMemberRole(hub, actorId, documentId, targetUserId, role) {
  await requirePermission(actorId, documentId, 'members:manage', MANAGE_ONLY);

  const target = await memberRepo.findMember(documentId, targetUserId);
  if (!target) throw AppError.notFound('Member not found');
  if (target.role === 'OWNER') throw AppError.conflict("The owner's role cannot be changed");
  if (target.role === role) return target;

  const updated = await memberRepo.updateMemberRole(documentId, targetUserId, role);
  hub?.notifyAccessChanged(documentId, targetUserId);
  return updated;
}

export async function removeMember(hub, actorId, documentId, targetUserId) {
  const { role: actorRole } = await requireAccess(actorId, documentId);
  const leaving = actorId === targetUserId;

  if (!leaving && !can(actorRole, 'members:manage')) throw AppError.forbidden(MANAGE_ONLY);

  const target = await memberRepo.findMember(documentId, targetUserId);
  if (!target) throw AppError.notFound('Member not found');
  if (target.role === 'OWNER') {
    throw AppError.conflict(
      leaving
        ? 'The owner cannot leave their own document; delete it instead'
        : 'The owner cannot be removed',
    );
  }

  await memberRepo.removeMember(documentId, targetUserId);
  hub?.notifyAccessChanged(documentId, targetUserId);
}
