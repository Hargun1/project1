import * as Y from 'yjs';
import { simpleDiffString } from 'lib0/diff';
import { YDOC_TEXT_KEY } from '@collab/shared';
import * as revisionRepo from '../repositories/revision.repository.js';
import { AppError } from '../utils/app-error.js';
import { requirePermission } from './access.service.js';
import { env } from '../config/env.js';

/**
 * Revision history (§25).
 *
 * A revision is an append-only binary Yjs snapshot (`Y.encodeStateAsUpdate`).
 * They are created inside the same row-locked transaction that saves the live
 * state (see `withLockedDocumentState`), so several backend instances can never
 * hand out the same revision number or both decide a checkpoint is due.
 *
 * When one is created:
 *
 *   AUTO     on a save, if the visible text changed since the latest revision
 *            and DOC_REVISION_INTERVAL_MS has passed; and when the last client
 *            on an instance leaves (interval ignored), so every editing session
 *            ends with a checkpoint
 *   MANUAL   "Save version" — returns the latest revision instead if nothing
 *            changed, so double-clicking does not create duplicates (the very
 *            first one is always created, even for an empty document)
 *   RESTORE  always
 */

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** @param {Uint8Array | null} state @returns {string} the document's text */
export function textOfState(state) {
  const doc = new Y.Doc();
  try {
    if (state) Y.applyUpdate(doc, state);
    return doc.getText(YDOC_TEXT_KEY).toString();
  } finally {
    doc.destroy();
  }
}

/**
 * Make `ytext` read `nextText` using *new* CRDT operations.
 *
 * Why not apply the old snapshot to the live document, as the spec's first
 * sketch suggests? Because that is a no-op: CRDT state only grows, and every
 * operation in an old snapshot is already part of the live document's history —
 * including the deletions made since. Restoring is therefore an edit like any
 * other: compute the difference between the current and the target text and
 * apply it. Connected clients receive it as a normal update, and characters
 * outside the changed range keep their identity (and anyone's cursor there).
 *
 * The diff is common-prefix/common-suffix (lib0's `simpleDiffString`): one
 * delete and one insert. Cheap and always correct; a character-level diff would
 * preserve more identities in the middle, at more cost and complexity.
 *
 * @param {Y.Text} ytext
 * @param {string} nextText
 * @param {unknown} origin
 */
export function replaceText(ytext, nextText, origin) {
  const { index, remove, insert } = simpleDiffString(ytext.toString(), nextText);
  if (remove === 0 && insert === '') return;
  ytext.doc.transact(() => {
    if (remove > 0) ytext.delete(index, remove);
    if (insert !== '') ytext.insert(index, insert);
  }, origin);
}

/**
 * Decide whether `snapshot` becomes a new revision, and create it. Runs inside
 * the document's row lock.
 *
 * @param {object} ops        from `withLockedDocumentState`
 * @param {Uint8Array} snapshot  the state that was just written
 * @param {{ kind: 'AUTO' | 'MANUAL' | 'RESTORE', createdById: string | null,
 *           restoredFromNumber?: number, ignoreInterval?: boolean }} request
 * @param {number} [now]
 * @returns {Promise<{ revision: object, created: boolean } | null>}
 */
export async function recordRevision(ops, snapshot, request, now = Date.now()) {
  const latest = await ops.latestRevision();

  if (
    request.kind === 'AUTO' &&
    !request.ignoreInterval &&
    latest &&
    now - latest.createdAt.getTime() < env.DOC_REVISION_INTERVAL_MS
  ) {
    return null;
  }

  // Compare *text*, not bytes: typing and deleting a character changes the
  // CRDT state but not the content, and is not worth a revision.
  if (request.kind === 'MANUAL' && latest) {
    if (textOfState(await ops.revisionSnapshot(latest.id)) === textOfState(snapshot)) {
      return { revision: latest, created: false };
    }
  }
  if (request.kind === 'AUTO') {
    const previous = latest ? textOfState(await ops.revisionSnapshot(latest.id)) : '';
    if (previous === textOfState(snapshot)) return null;
  }

  const revision = await ops.createRevision({
    revisionNumber: (latest?.revisionNumber ?? 0) + 1,
    snapshot,
    createdById: request.createdById ?? null,
    kind: request.kind,
    restoredFromNumber: request.restoredFromNumber ?? null,
  });
  return { revision, created: true };
}

/**
 * Whether a save with `request` settled the question "is a checkpoint due for
 * the edits so far?". Only an AUTO save that was skipped for the interval
 * leaves it open.
 */
export function revisionDecided(request, result) {
  return !(request.kind === 'AUTO' && !request.ignoreInterval && result === null);
}

// ── REST-facing operations ──────────────────────────────────────────────────

/** Any member may read the history: viewing is reading (§16). */
export async function listRevisions(userId, documentId, { page, limit }) {
  await requirePermission(userId, documentId, 'document:read');
  const { revisions, total } = await revisionRepo.listRevisions(documentId, {
    skip: (page - 1) * limit,
    take: limit,
  });
  return { data: revisions, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

/**
 * One revision with its text. The binary snapshot is decoded here and never
 * sent to the browser.
 */
export async function getRevision(userId, documentId, revisionId) {
  await requirePermission(userId, documentId, 'document:read');
  const row = await revisionRepo.getRevisionWithSnapshot(documentId, revisionId);
  if (!row) throw AppError.notFound('Revision not found');
  const { snapshot, ...revision } = row;
  return { ...revision, content: textOfState(snapshot) };
}

/** "Save version": OWNER and EDITOR may create revisions (§16). */
export async function createManualRevision(hub, userId, documentId) {
  await requirePermission(userId, documentId, 'revision:create', 'Viewers cannot save versions');
  return hub.createRevision(documentId, userId);
}

/** Only the OWNER may restore (§16: EDITOR and VIEWER cannot). */
export async function restoreRevision(hub, userId, documentId, revisionId) {
  await requirePermission(
    userId,
    documentId,
    'revision:restore',
    'Only the owner can restore revisions',
  );
  const target = await revisionRepo.getRevisionWithSnapshot(documentId, revisionId);
  if (!target) throw AppError.notFound('Revision not found');
  return hub.restoreRevision(documentId, target, userId);
}
