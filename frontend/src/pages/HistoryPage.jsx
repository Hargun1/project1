import '../utils/monaco-setup.js';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { can } from '@collab/shared';
import { useAuth } from '../auth/useAuth.js';
import * as docService from '../services/document.service.js';
import { monacoLanguage } from '../utils/languages.js';
import { formatRelative } from '../utils/time.js';

const PAGE_SIZE = 20;

const KIND_LABEL = {
  AUTO: { text: 'Auto', className: 'bg-zinc-800 text-zinc-400' },
  MANUAL: { text: 'Saved', className: 'bg-emerald-500/10 text-emerald-300' },
  RESTORE: { text: 'Restore', className: 'bg-amber-500/10 text-amber-300' },
};

/**
 * Revision history (§25): `/documents/:documentId/history`.
 *
 * Every member can browse; only the OWNER sees "Restore" — and the server
 * enforces that independently. Restoring creates a *new* revision and rewrites
 * the live document for everyone connected; nothing in the list is ever removed.
 */
export function HistoryPage() {
  const { documentId } = useParams();
  const { getAccessToken } = useAuth();
  const navigate = useNavigate();

  const [doc, setDoc] = useState(null);
  const [revisions, setRevisions] = useState([]);
  const [meta, setMeta] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const loadPage = useCallback(
    async (page) => {
      const token = await getAccessToken();
      const result = await docService.listRevisions(token, documentId, { page, limit: PAGE_SIZE });
      setMeta(result.meta);
      setRevisions((previous) => (page === 1 ? result.data : [...previous, ...result.data]));
      return result.data;
    },
    [documentId, getAccessToken],
  );

  // Document metadata + first page of history.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadingList(true);
        const token = await getAccessToken();
        const [{ document }, firstPage] = await Promise.all([
          docService.getDocument(token, documentId),
          loadPage(1),
        ]);
        if (cancelled) return;
        setDoc(document);
        setSelectedId((current) => current ?? firstPage[0]?.id ?? null);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, getAccessToken, loadPage]);

  // Content of the selected revision.
  useEffect(() => {
    if (!selectedId) {
      setPreview(null);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        setLoadingPreview(true);
        const { revision } = await docService.getRevision(
          await getAccessToken(),
          documentId,
          selectedId,
        );
        if (!cancelled) setPreview(revision);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, documentId, getAccessToken]);

  const handleRestore = async () => {
    if (!preview) return;
    const confirmed = window.confirm(
      `Restore revision ${preview.revisionNumber}?\n\n` +
        'The document will change for everyone editing it right now. Nothing is deleted: ' +
        'the current content stays in history and the restore is saved as a new revision.',
    );
    if (!confirmed) return;
    try {
      setRestoring(true);
      setError(null);
      const { revision } = await docService.restoreRevision(
        await getAccessToken(),
        documentId,
        preview.id,
      );
      setNotice(
        `Restored revision ${preview.revisionNumber} as revision ${revision.revisionNumber}.`,
      );
      await loadPage(1);
      setSelectedId(revision.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setRestoring(false);
    }
  };

  const latestNumber = revisions[0]?.revisionNumber;
  const canLoadMore = meta && meta.page < meta.totalPages;

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-800/80 bg-zinc-900/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={`/editor/${documentId}`}
            className="rounded-md px-2 py-1 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          >
            ← Back to editor
          </Link>
          <h1 className="truncate text-sm font-semibold">
            {doc?.name ?? 'Document'} <span className="font-normal text-zinc-500">· History</span>
          </h1>
        </div>
        {can(doc?.role, 'revision:restore') &&
          preview &&
          preview.revisionNumber !== latestNumber && (
            <button
              type="button"
              onClick={handleRestore}
              disabled={restoring}
              className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-amber-500 disabled:opacity-50"
            >
              {restoring ? 'Restoring…' : `Restore revision ${preview.revisionNumber}`}
            </button>
          )}
      </header>

      {(error || notice) && (
        <div
          role="status"
          className={`flex shrink-0 items-center justify-between border-b px-4 py-1.5 text-xs ${
            error
              ? 'border-red-500/20 bg-red-500/5 text-red-300'
              : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
          }`}
        >
          <span>{error ?? notice}</span>
          <span className="flex gap-3">
            {notice && !error && (
              <button
                type="button"
                onClick={() => navigate(`/editor/${documentId}`)}
                className="underline"
              >
                Open editor
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setNotice(null);
              }}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="max-h-64 shrink-0 overflow-y-auto border-b border-zinc-800/80 md:max-h-none md:w-72 md:border-r md:border-b-0">
          {loadingList ? (
            <p className="p-4 text-sm text-zinc-500">Loading history…</p>
          ) : revisions.length === 0 ? (
            <p className="p-4 text-sm leading-relaxed text-zinc-500">
              No revisions yet. A revision is saved automatically every few minutes while the
              document is edited, when everyone has left it, and whenever someone clicks
              <span className="text-zinc-300"> Save version</span>.
            </p>
          ) : (
            <ol>
              {revisions.map((revision) => {
                const kind = KIND_LABEL[revision.kind] ?? KIND_LABEL.AUTO;
                const selected = revision.id === selectedId;
                return (
                  <li key={revision.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(revision.id)}
                      aria-current={selected ? 'true' : undefined}
                      className={`w-full border-l-2 px-4 py-2.5 text-left transition ${
                        selected
                          ? 'border-emerald-400 bg-zinc-800/60'
                          : 'border-transparent hover:bg-zinc-900'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          Revision {revision.revisionNumber}
                          {revision.revisionNumber === latestNumber && (
                            <span className="ml-1.5 text-xs font-normal text-zinc-500">latest</span>
                          )}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${kind.className}`}
                        >
                          {kind.text}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500">
                        {revision.createdBy?.name ?? 'Automatic'} ·{' '}
                        <time
                          dateTime={revision.createdAt}
                          title={new Date(revision.createdAt).toLocaleString()}
                        >
                          {formatRelative(revision.createdAt)}
                        </time>
                      </span>
                      {revision.kind === 'RESTORE' && revision.restoredFromNumber && (
                        <span className="mt-0.5 block text-xs text-amber-300/80">
                          ← restored from revision {revision.restoredFromNumber}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {canLoadMore && (
            <button
              type="button"
              onClick={() => loadPage(meta.page + 1).catch((err) => setError(err.message))}
              className="w-full px-4 py-2 text-xs text-zinc-400 hover:text-white"
            >
              Load older revisions
            </button>
          )}
        </aside>

        <section className="relative min-h-0 flex-1" aria-label="Revision content">
          {preview ? (
            <Editor
              value={preview.content}
              language={monacoLanguage(doc?.language)}
              theme="vs-dark"
              options={{
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                fontSize: 14,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 16 },
              }}
            />
          ) : (
            !loadingList && (
              <p className="p-6 text-sm text-zinc-500">Select a revision to see its content.</p>
            )
          )}
          {loadingPreview && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-zinc-950/50">
              <span className="text-xs text-zinc-400">Loading revision…</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
