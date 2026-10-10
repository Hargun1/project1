import { randomUUID } from 'node:crypto';

/**
 * In-memory stand-in for the document's persisted state and revision rows, with
 * the same `withLockedDocumentState` contract as the repository — including
 * serialisation, which the real one gets from `SELECT … FOR UPDATE`.
 *
 * One instance per test file (vitest isolates module graphs per file).
 */
export const fakeStore = {
  state: null,
  revisions: [],
  /** When true, writes are accepted but not stored: PostgreSQL "lags". */
  frozen: false,
  saves: 0,
  lock: Promise.resolve(),

  reset() {
    this.state = null;
    this.revisions = [];
    this.frozen = false;
    this.saves = 0;
    this.lock = Promise.resolve();
  },

  withLockedDocumentState(documentId, fn) {
    const run = this.lock.then(() =>
      fn({
        current: this.state,
        writeState: async (state) => {
          this.saves += 1;
          if (!this.frozen) this.state = state;
        },
        latestRevision: async () => this.revisions.at(-1) ?? null,
        revisionSnapshot: async (id) => this.revisions.find((r) => r.id === id).snapshot,
        createRevision: async (data) => {
          const revision = {
            id: randomUUID(),
            documentId,
            createdAt: new Date(),
            createdBy: data.createdById ? { id: data.createdById, name: 'someone' } : null,
            ...data,
          };
          this.revisions.push(revision);
          return revision;
        },
      }),
    );
    this.lock = run.catch(() => {});
    return run;
  },
};
