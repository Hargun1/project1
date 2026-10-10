import '../utils/monaco-setup.js';
import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import { Awareness } from 'y-protocols/awareness';
import { can, YDOC_TEXT_KEY } from '@collab/shared';
import { useAuth } from '../auth/useAuth.js';
import * as docService from '../services/document.service.js';
import { monacoLanguage, LANGUAGE_OPTIONS } from '../utils/languages.js';
import { WS_STATUS } from '../websocket/ws-client.js';
import { createCollabProvider, SAVE_STATUS } from '../collaboration/collab-provider.js';
import { buildCursorCss } from '../collaboration/cursor-styles.js';
import { groupByUser, usePresence } from '../hooks/usePresence.js';
import { CollaboratorAvatars, CollaboratorList } from '../components/Collaborators.jsx';
import { ShareDialog } from '../components/ShareDialog.jsx';
import { useToast } from '../toast/toast-context.js';
import { roleLabel } from '../utils/roles.js';

/**
 * Collaborative editor (§9, §18, §30).
 *
 * State is split on purpose:
 *
 *   - Server state (document name, language, your role) comes from REST.
 *   - Collaboration state (the text) lives in a `Y.Doc`. The y-monaco binding
 *     moves edits between Monaco's model and the `Y.Text` directly; React never
 *     holds the document text, so a keystroke does not re-render this page.
 *   - Presence lives in a y-protocols `Awareness`. Remote cursors are drawn by
 *     y-monaco as editor decorations; React only sees the list of people.
 *   - Only derived status (connection, save state, who is here) is React state.
 */

const SAVE_BADGE = {
  [SAVE_STATUS.SAVED]: {
    text: 'Saved',
    className: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  },
  [SAVE_STATUS.SAVING]: {
    text: 'Saving…',
    className: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
  },
  [SAVE_STATUS.FAILED]: {
    text: 'Save failed',
    className: 'text-red-400 bg-red-500/10 border-red-500/20',
  },
  [SAVE_STATUS.OFFLINE]: {
    text: 'Offline',
    className: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20',
  },
};

const CONNECTION_BADGE = {
  [WS_STATUS.CONNECTED]: { dot: 'bg-emerald-400', text: 'Connected' },
  [WS_STATUS.CONNECTING]: { dot: 'bg-yellow-400 animate-pulse', text: 'Connecting…' },
  [WS_STATUS.RECONNECTING]: { dot: 'bg-yellow-400 animate-pulse', text: 'Reconnecting…' },
  [WS_STATUS.DISCONNECTED]: { dot: 'bg-zinc-500', text: 'Disconnected' },
  [WS_STATUS.ERROR]: { dot: 'bg-red-400', text: 'Connection refused' },
};

export function EditorPage() {
  const toast = useToast();
  const { documentId } = useParams();
  const { getAccessToken, user } = useAuth();
  const navigate = useNavigate();

  // ── Server state ──────────────────────────────────────────────────────
  const [doc, setDoc] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [language, setLanguage] = useState('javascript');

  // ── Collaboration state (derived only) ────────────────────────────────
  /** The Y.Doc and its Awareness are created and destroyed together. */
  const [collab, setCollab] = useState(null);
  const [editor, setEditor] = useState(null);
  const [synced, setSynced] = useState(false);
  const [connection, setConnection] = useState({ status: WS_STATUS.CONNECTING, detail: null });
  const [saveStatus, setSaveStatus] = useState(SAVE_STATUS.OFFLINE);
  const [protocolError, setProtocolError] = useState(null);
  /** 'degraded' while this backend cannot reach Redis, i.e. other instances (§43). */
  const [clusterState, setClusterState] = useState('ok');
  /**
   * Bumped to throw away the local Y.Doc and re-sync from the server (Phase 11):
   * when the server refuses an edit (size limit), the local copy contains text
   * nobody else has and would re-send it on every reconnect.
   */
  const [syncGeneration, setSyncGeneration] = useState(0);

  const role = doc?.role;
  // Every UI decision uses the same permission matrix the server enforces.
  const isReadOnly = !can(role, 'document:edit');
  const [shareOpen, setShareOpen] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);

  // ── Load document metadata ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setLoadError(null);

    (async () => {
      try {
        const { document } = await docService.getDocument(await getAccessToken(), documentId);
        if (cancelled) return;
        setDoc(document);
        setLanguage(document.language);
      } catch (err) {
        if (!cancelled) setLoadError(err.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentId, getAccessToken]);

  const docLoaded = doc !== null;

  // ── Y.Doc + sync provider: one per open document ─────────────────────
  useEffect(() => {
    if (!docLoaded) return undefined;

    const nextDoc = new Y.Doc();
    const nextAwareness = new Awareness(nextDoc);
    // Nothing to announce until the server confirms who we are (`joined`).
    nextAwareness.setLocalState(null);
    setCollab({ ydoc: nextDoc, awareness: nextAwareness });
    setSynced(false);

    const provider = createCollabProvider({
      documentId,
      ydoc: nextDoc,
      awareness: nextAwareness,
      getAccessToken,
      onConnectionChange: (status, detail) => setConnection({ status, detail: detail ?? null }),
      onSaveStatusChange: setSaveStatus,
      onClusterChange: setClusterState,
      // Phase 10: an owner changed our role while we were connected.
      onRoleChange: (nextRole) =>
        setDoc((current) => (current ? { ...current, role: nextRole } : current)),
      onSynced: () => setSynced(true),
      onError: (error) => {
        setProtocolError(error);
        if (error.code === 'DOCUMENT_TOO_LARGE') setSyncGeneration((n) => n + 1);
      },
    });

    return () => {
      provider.destroy();
      nextAwareness.destroy();
      nextDoc.destroy();
      setCollab(null);
    };
  }, [docLoaded, documentId, getAccessToken, syncGeneration]);

  // ── Monaco ⇄ Y.Text binding ──────────────────────────────────────────
  useEffect(() => {
    if (!editor || !collab) return undefined;
    const model = editor.getModel();
    if (!model) return undefined;

    // Normalise line endings: Y.Text stores exactly what Monaco reports, so two
    // clients on different OSes must not disagree about "\r\n" vs "\n".
    model.setEOL(0); // monaco.editor.EndOfLineSequence.LF
    // Passing the awareness makes y-monaco publish our selection and draw
    // everyone else's.
    const binding = new MonacoBinding(
      collab.ydoc.getText(YDOC_TEXT_KEY),
      model,
      new Set([editor]),
      collab.awareness,
    );

    return () => binding.destroy();
  }, [editor, collab]);

  // ── Presence ─────────────────────────────────────────────────────────
  const collaborators = usePresence(collab?.awareness ?? null);
  const people = useMemo(() => groupByUser(collaborators), [collaborators]);
  const cursorCss = useMemo(
    () =>
      buildCursorCss(
        collaborators
          .filter((c) => !c.isLocal)
          .map((c) => ({ clientID: c.clientID, color: c.user.color, name: c.user.name })),
      ),
    [collaborators],
  );

  // ── Language change (metadata, OWNER only — enforced by the server) ──
  // ── "Save version" (OWNER/EDITOR — enforced by the server) ───────────
  const handleSaveVersion = async () => {
    try {
      setSavingVersion(true);
      const { revision, created } = await docService.createRevision(
        await getAccessToken(),
        documentId,
      );
      if (created) toast.success(`Saved as revision ${revision.revisionNumber}`);
      else toast.info(`No changes since revision ${revision.revisionNumber}`);
    } catch (err) {
      toast.error(`Could not save a version: ${err.message}`);
    } finally {
      setSavingVersion(false);
    }
  };

  const handleLanguageChange = async (next) => {
    const previous = language;
    setLanguage(next);
    try {
      await docService.updateDocument(await getAccessToken(), documentId, { language: next });
    } catch (err) {
      setLanguage(previous);
      toast.error(`Could not change the language: ${err.message}`);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="grid h-screen place-items-center bg-zinc-950 px-4">
        <div role="alert" className="w-full max-w-sm text-center">
          <div
            aria-hidden="true"
            className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-red-500/10 font-mono text-lg text-red-300 ring-1 ring-red-500/20"
          >
            !
          </div>
          <h1 className="text-lg font-semibold text-white">Can&apos;t open this document</h1>
          <p className="mt-2 text-sm text-zinc-400">
            {loadError}. It may have been deleted, or the owner may have removed your access.
          </p>
          <Link
            to="/dashboard"
            className="mt-6 inline-block rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white"
          >
            Back to your documents
          </Link>
        </div>
      </div>
    );
  }

  if (!doc) {
    return <FullScreenSpinner label="Loading document…" />;
  }

  const saveBadge = SAVE_BADGE[saveStatus] ?? SAVE_BADGE[SAVE_STATUS.OFFLINE];
  const connBadge = CONNECTION_BADGE[connection.status] ?? CONNECTION_BADGE[WS_STATUS.DISCONNECTED];

  return (
    <div className="flex h-screen flex-col bg-zinc-950">
      {/* ─── Top toolbar ──────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-zinc-800/80 bg-zinc-900/60 px-3 py-2 backdrop-blur sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/dashboard"
            className="grid size-8 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30 transition ring-inset hover:bg-emerald-500/25"
            title="Back to Dashboard"
            aria-label="Back to Dashboard"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="size-4"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
                clipRule="evenodd"
              />
            </svg>
          </Link>

          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-white" title={doc.name}>
              {doc.name}
            </h1>
            {doc.owner && <p className="truncate text-xs text-zinc-500">by {doc.owner.name}</p>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <CollaboratorAvatars people={people} />

          {can(role, 'revision:create') && (
            <button
              type="button"
              onClick={handleSaveVersion}
              disabled={savingVersion || !synced}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
            >
              {savingVersion ? 'Saving…' : 'Save version'}
            </button>
          )}
          <Link
            to={`/documents/${documentId}/history`}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
          >
            History
          </Link>
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-emerald-500"
          >
            Share
          </button>

          <label htmlFor="editor-language-select" className="sr-only">
            Language
          </label>
          <select
            id="editor-language-select"
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value)}
            disabled={!can(role, 'document:rename')}
            title={
              can(role, 'document:rename')
                ? 'Change language'
                : 'Only the owner can change the language'
            }
            className="hidden rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 outline-none transition focus:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 sm:block"
          >
            {LANGUAGE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          {isReadOnly ? (
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
              Read-only
            </span>
          ) : (
            <span
              role="status"
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${saveBadge.className}`}
            >
              {saveBadge.text}
            </span>
          )}

          {role && (
            <span
              className="hidden rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400 sm:inline"
              title="Your role on this document"
            >
              {roleLabel(role)}
            </span>
          )}
        </div>
      </header>

      {protocolError && (
        <div className="flex shrink-0 items-center justify-between border-b border-red-500/20 bg-red-500/5 px-4 py-1.5 text-xs text-red-300">
          <span>
            {protocolError.message}{' '}
            <span className="font-mono text-red-400/70">({protocolError.code})</span>
          </span>
          <button
            type="button"
            onClick={() => setProtocolError(null)}
            className="text-red-300 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Per-collaborator cursor colours; every value is escaped (cursor-styles.js). */}
      <style>{cursorCss}</style>

      {/* ─── Monaco Editor ────────────────────────────────────────────── */}
      <div className="relative flex-1 overflow-hidden">
        <Editor
          // No `value`/`defaultValue`: the text arrives through the Y.Doc.
          language={monacoLanguage(language)}
          theme="vs-dark"
          onMount={setEditor}
          options={{
            // Writable only once the initial sync has delivered the server's
            // state, so nobody types into an empty buffer that is about to fill.
            readOnly: isReadOnly || !synced,
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
            fontLigatures: true,
            // The minimap costs a quarter of a phone screen; keep it for wider ones.
            minimap: { enabled: window.innerWidth >= 768 },
            lineNumbers: 'on',
            scrollBeyondLastLine: true,
            automaticLayout: true,
            tabSize: 2,
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
            padding: { top: 16 },
          }}
          loading={<FullScreenSpinner label="Loading editor…" />}
        />
        {!synced && connection.status !== WS_STATUS.ERROR && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-zinc-950/60">
            <span className="text-xs text-zinc-400">Syncing document…</span>
          </div>
        )}
        {/* Phase 10: access removed, document deleted, or ticket refused. The
            server closed the socket with a permanent code, so we do not retry. */}
        {connection.status === WS_STATUS.ERROR && (
          <div
            role="alert"
            className="absolute inset-0 grid place-items-center bg-zinc-950/85 px-4 text-center"
          >
            <div className="max-w-sm space-y-3">
              <p className="text-sm font-medium text-white">
                {connection.detail ?? 'You can no longer open this document.'}
              </p>
              <Link
                to="/dashboard"
                className="inline-block text-sm text-emerald-400 hover:underline"
              >
                ← Back to Dashboard
              </Link>
            </div>
          </div>
        )}
      </div>

      {shareOpen && user && (
        <ShareDialog
          documentId={documentId}
          myUserId={user.id}
          myRole={role}
          getAccessToken={getAccessToken}
          onClose={() => setShareOpen(false)}
          onLeft={() => navigate('/dashboard', { replace: true })}
        />
      )}

      {/* ─── Status bar ───────────────────────────────────────────────── */}
      <footer className="flex shrink-0 items-center justify-between border-t border-zinc-800/80 bg-zinc-900/40 px-4 py-1.5 text-xs text-zinc-500">
        <div className="flex min-w-0 items-center gap-4">
          <span className="font-mono">{monacoLanguage(language)}</span>
          <span>UTF-8 · LF</span>
          <CollaboratorList people={people} />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {clusterState === 'degraded' && connection.status === WS_STATUS.CONNECTED && (
            <span
              role="status"
              className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-amber-400"
              title="This server has lost contact with the others. Your edits are saved, but people connected to a different server will only see them once the connection recovers."
            >
              Degraded: other servers out of sync
            </span>
          )}
          <span
            className="flex items-center gap-1.5"
            role="status"
            title={connection.detail ?? undefined}
          >
            <span
              className={`inline-block size-2 rounded-full ${connBadge.dot}`}
              aria-hidden="true"
            />
            {connBadge.text}
            {connection.status === WS_STATUS.ERROR && connection.detail
              ? ` — ${connection.detail}`
              : ''}
          </span>
        </div>
      </footer>
    </div>
  );
}

function FullScreenSpinner({ label }) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-zinc-950">
      <div className="flex flex-col items-center gap-3">
        <div className="size-8 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
        <span className="text-sm text-zinc-400">{label}</span>
      </div>
    </div>
  );
}
