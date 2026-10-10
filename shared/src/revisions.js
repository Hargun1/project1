/**
 * Revision history contracts (Phase 9).
 *
 * Revisions are append-only binary Yjs snapshots. `kind` records why one exists:
 *
 *   AUTO     periodic checkpoint while saving, and one when everyone has left
 *   MANUAL   "Save version" pressed by an OWNER or EDITOR
 *   RESTORE  the result of restoring an older revision; `restoredFromNumber`
 *            names it. Restoring never deletes or rewrites history.
 *
 * Revision shape on the wire (the binary snapshot never leaves the server):
 *
 *   { id, revisionNumber, kind, restoredFromNumber, createdAt,
 *     createdBy: { id, name } | null,
 *     content?: string }              only on GET /revisions/:revisionId
 */
export const REVISION_KINDS = ['AUTO', 'MANUAL', 'RESTORE'];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRevisionKind(value) {
  return typeof value === 'string' && REVISION_KINDS.includes(value);
}
