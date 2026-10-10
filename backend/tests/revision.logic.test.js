import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YDOC_TEXT_KEY } from '@collab/shared';
import { recordRevision, replaceText, textOfState } from '../src/services/revision.service.js';
import { fakeStore } from './helpers/fake-document-store.js';

const stateOf = (text) => {
  const doc = new Y.Doc();
  doc.getText(YDOC_TEXT_KEY).insert(0, text);
  return Y.encodeStateAsUpdate(doc);
};

describe('restoring content', () => {
  it('cannot be done by applying the old snapshot: CRDT state only grows', () => {
    const live = new Y.Doc();
    const text = live.getText(YDOC_TEXT_KEY);
    text.insert(0, 'version one');
    const revision1 = Y.encodeStateAsUpdate(live);
    text.delete(0, text.length);
    text.insert(0, 'version two');

    // The naive mechanic: everything in revision 1 is already in the live
    // history, including the deletion of it, so nothing changes.
    Y.applyUpdate(live, revision1);
    expect(text.toString()).toBe('version two');
  });

  it('rewrites the live text to the old text with new operations', () => {
    const live = new Y.Doc();
    const text = live.getText(YDOC_TEXT_KEY);
    text.insert(0, 'version one');
    const revision1 = Y.encodeStateAsUpdate(live);
    text.delete(0, text.length);
    text.insert(0, 'version two, much longer');

    replaceText(text, textOfState(revision1), 'restore');
    expect(text.toString()).toBe('version one');
  });

  it('reaches other replicas as an ordinary update and merges with concurrent edits', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText(YDOC_TEXT_KEY).insert(0, 'header\nbody: new\nfooter');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // A restores while B, concurrently, edits the last line.
    replaceText(a.getText(YDOC_TEXT_KEY), 'header\nbody: old\nfooter', 'restore');
    b.getText(YDOC_TEXT_KEY).insert(b.getText(YDOC_TEXT_KEY).length, '!');

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(a.getText(YDOC_TEXT_KEY).toString()).toBe('header\nbody: old\nfooter!');
    expect(b.getText(YDOC_TEXT_KEY).toString()).toBe(a.getText(YDOC_TEXT_KEY).toString());
  });

  it('only touches the changed range, so text around it keeps its identity', () => {
    const doc = new Y.Doc();
    const text = doc.getText(YDOC_TEXT_KEY);
    text.insert(0, 'keep MIDDLE keep');
    const before = Y.createRelativePositionFromTypeIndex(text, 14); // inside the suffix

    const updates = [];
    doc.on('update', (u) => updates.push(u));
    replaceText(text, 'keep middle keep', 'restore');

    expect(updates).toHaveLength(1); // one transaction
    expect(Y.createAbsolutePositionFromRelativePosition(before, doc).index).toBe(14);
  });

  it('is a no-op when the text already matches', () => {
    const doc = new Y.Doc();
    doc.getText(YDOC_TEXT_KEY).insert(0, 'same');
    let updates = 0;
    doc.on('update', () => (updates += 1));
    replaceText(doc.getText(YDOC_TEXT_KEY), 'same', 'restore');
    expect(updates).toBe(0);
  });
});

describe('when a revision is recorded', () => {
  const save = (text, request, now) =>
    fakeStore.withLockedDocumentState('doc', (ops) =>
      recordRevision(ops, stateOf(text), request, now),
    );

  beforeEach(() => fakeStore.reset());

  it('numbers revisions 1, 2, 3 per document', async () => {
    await save('a', { kind: 'MANUAL', createdById: 'u' });
    await save('ab', { kind: 'MANUAL', createdById: 'u' });
    await save('abc', { kind: 'MANUAL', createdById: 'u' });
    expect(fakeStore.revisions.map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
  });

  it('takes an AUTO checkpoint only after the interval (5 min by default)', async () => {
    const t0 = Date.now();
    expect(await save('first', { kind: 'AUTO' }, t0)).toMatchObject({ created: true });
    expect(await save('second', { kind: 'AUTO' }, t0 + 60_000)).toBeNull();
    expect(await save('third', { kind: 'AUTO' }, t0 + 301_000)).toMatchObject({ created: true });
  });

  it('ignores the interval for the end-of-session checkpoint', async () => {
    await save('first', { kind: 'AUTO' });
    const result = await save('second', { kind: 'AUTO', ignoreInterval: true });
    expect(result).toMatchObject({ created: true });
  });

  it('does not checkpoint when the visible text did not change', async () => {
    await save('same', { kind: 'AUTO' });
    expect(await save('same', { kind: 'AUTO', ignoreInterval: true })).toBeNull();
  });

  it('answers a repeated "save version" with the existing revision', async () => {
    const first = await save('v', { kind: 'MANUAL', createdById: 'u' });
    const again = await save('v', { kind: 'MANUAL', createdById: 'u' });
    expect(again).toEqual({ revision: first.revision, created: false });
    expect(fakeStore.revisions).toHaveLength(1);
  });

  it('always records a restore, with what it restored from', async () => {
    await save('one', { kind: 'MANUAL', createdById: 'u' });
    await save('two', { kind: 'MANUAL', createdById: 'u' });
    const result = await save('one', { kind: 'RESTORE', createdById: 'u', restoredFromNumber: 1 });
    expect(result.revision).toMatchObject({
      revisionNumber: 3,
      kind: 'RESTORE',
      restoredFromNumber: 1,
    });
  });

  it('never records an empty first document', async () => {
    expect(await save('', { kind: 'AUTO', ignoreInterval: true })).toBeNull();
    expect(fakeStore.revisions).toHaveLength(0);
  });
});
