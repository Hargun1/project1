import { useCallback, useEffect, useRef, useState } from 'react';
import { ASSIGNABLE_ROLES, can } from '@collab/shared';
import * as docService from '../services/document.service.js';
import { useToast } from '../toast/toast-context.js';
import { ROLE_LABELS as ROLE_LABEL } from '../utils/roles.js';

/**
 * "Share" dialog (§2.8–2.9): who has access, and — for the owner — invite,
 * change role, remove. Any non-owner can leave.
 *
 * What is shown depends on `can(myRole, 'members:manage')`, the same matrix the
 * server enforces; every action is still checked by the server, which is why
 * each one handles a 403/409 and reloads the list afterwards.
 *
 * @param {object} props
 * @param {string} props.documentId
 * @param {string} props.myUserId
 * @param {string} props.myRole
 * @param {() => Promise<string>} props.getAccessToken
 * @param {() => void} props.onClose
 * @param {() => void} props.onLeft  called after you removed yourself
 */
export function ShareDialog({ documentId, myUserId, myRole, getAccessToken, onClose, onLeft }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('EDITOR');
  const dialogRef = useRef(null);
  const canManage = can(myRole, 'members:manage');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const { members: list } = await docService.listMembers(await getAccessToken(), documentId);
      setMembers(list);
    } catch (err) {
      setError(err.message);
    }
  }, [documentId, getAccessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape closes; focus moves into the dialog for keyboard users.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Run an action, show its error if any, then reload the authoritative list. */
  const run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action(await getAccessToken());
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
      void load();
    }
  };

  const handleInvite = async (event) => {
    event.preventDefault();
    const ok = await run((token) =>
      docService.addMember(token, documentId, { email, role: inviteRole }),
    );
    if (ok) {
      toast.success(`Invited ${email.trim()} as ${ROLE_LABEL[inviteRole].toLowerCase()}`);
      setEmail('');
    }
  };

  const handleLeave = async () => {
    if (
      !window.confirm(
        'Leave this document? You will lose access until the owner invites you again.',
      )
    ) {
      return;
    }
    const ok = await run((token) => docService.removeMember(token, documentId, myUserId));
    if (ok) {
      toast.info('You left the document');
      onLeft();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 p-5 text-sm text-zinc-200 shadow-xl outline-none"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="share-title" className="text-base font-semibold text-white">
            Share document
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-400 hover:text-white"
          >
            ✕
          </button>
        </div>

        {canManage && (
          <form onSubmit={handleInvite} className="mb-4 flex flex-wrap gap-2">
            <label htmlFor="share-email" className="sr-only">
              Email
            </label>
            <input
              id="share-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email of a registered user"
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 outline-none focus:border-emerald-500"
            />
            <label htmlFor="share-role" className="sr-only">
              Role
            </label>
            <select
              id="share-role"
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value)}
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5"
            >
              {ASSIGNABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Invite
            </button>
          </form>
        )}

        {error && (
          <p
            role="alert"
            className="mb-3 rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-red-300"
          >
            {error}
          </p>
        )}

        {members === null ? (
          <p className="text-zinc-500">Loading members…</p>
        ) : (
          <ul className="divide-y divide-zinc-800" aria-label="Members">
            {members.map((member) => {
              const isMe = member.userId === myUserId;
              const isOwner = member.role === 'OWNER';
              return (
                <li key={member.userId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-zinc-100">
                      {member.name}
                      {isMe ? ' (you)' : ''}
                    </p>
                    <p className="truncate text-xs text-zinc-500">{member.email}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {canManage && !isOwner ? (
                      <>
                        <label htmlFor={`role-${member.userId}`} className="sr-only">
                          Role for {member.name}
                        </label>
                        <select
                          id={`role-${member.userId}`}
                          value={member.role}
                          disabled={busy}
                          onChange={(event) =>
                            run((token) =>
                              docService.updateMember(
                                token,
                                documentId,
                                member.userId,
                                event.target.value,
                              ),
                            )
                          }
                          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs"
                        >
                          {ASSIGNABLE_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABEL[role]}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run((token) =>
                              docService.removeMember(token, documentId, member.userId),
                            )
                          }
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                        {ROLE_LABEL[member.role] ?? member.role}
                      </span>
                    )}
                    {isMe && !isOwner && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleLeave}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        Leave
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {!canManage && (
          <p className="mt-3 text-xs text-zinc-500">
            Only the owner can invite people or change roles.
          </p>
        )}
      </div>
    </div>
  );
}
