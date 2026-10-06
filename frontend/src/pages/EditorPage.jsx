import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { useAuth } from '../auth/useAuth.js';
import * as docService from '../services/document.service.js';
import { monacoLanguage, LANGUAGE_OPTIONS } from '../utils/languages.js';

/**
 * Phase 4 — Monaco Editor page.
 *
 * Implements: Editor, Syntax highlighting, Languages, Save/load (§9, §31, §48).
 *
 * The layout follows the spec's Editor UI wireframe: a top bar with document
 * name, language selector, save status, and a Monaco Editor filling the
 * remaining viewport height with a dark theme.
 */
export function EditorPage() {
  const { documentId } = useParams();
  const { accessToken } = useAuth();

  // ── Document state ────────────────────────────────────────────────────
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ── Editor state ──────────────────────────────────────────────────────
  const [content, setContent] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [saveStatus, setSaveStatus] = useState('saved'); // 'saved' | 'saving' | 'unsaved' | 'error'
  const [isReadOnly, setIsReadOnly] = useState(false);

  // Track whether the editor content has diverged from the last-saved value
  const savedContentRef = useRef('');
  const editorRef = useRef(null);
  const saveTimeoutRef = useRef(null);

  // ── Load document ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const res = await docService.getDocument(accessToken, documentId);
        if (cancelled) return;

        setDoc(res);
        setContent(res.content ?? '');
        setLanguage(res.language ?? 'javascript');
        savedContentRef.current = res.content ?? '';
        setSaveStatus('saved');

        // Viewers get a read-only editor
        if (res.role === 'VIEWER') {
          setIsReadOnly(true);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [accessToken, documentId]);

  // ── Save logic (debounced auto-save + manual Ctrl+S) ──────────────────
  const saveContent = useCallback(
    async (contentToSave) => {
      if (isReadOnly) return;
      try {
        setSaveStatus('saving');
        await docService.saveDocumentContent(accessToken, documentId, contentToSave);
        savedContentRef.current = contentToSave;
        setSaveStatus('saved');
      } catch {
        setSaveStatus('error');
      }
    },
    [accessToken, documentId, isReadOnly],
  );

  // Debounced auto-save: fire 1.5 s after the user stops typing.
  const debouncedSave = useCallback(
    (newContent) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => saveContent(newContent), 1500);
    },
    [saveContent],
  );

  // Clean up timer on unmount
  useEffect(() => () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
  }, []);

  // ── Editor handlers ───────────────────────────────────────────────────
  const handleEditorChange = (value) => {
    const newContent = value ?? '';
    setContent(newContent);
    if (newContent !== savedContentRef.current) {
      setSaveStatus('unsaved');
      debouncedSave(newContent);
    }
  };

  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;

    // Ctrl+S / Cmd+S to force-save immediately
    editor.addAction({
      id: 'save-document',
      label: 'Save Document',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveContent(editor.getValue());
      },
    });
  };

  // ── Language change ───────────────────────────────────────────────────
  const handleLanguageChange = async (newLang) => {
    setLanguage(newLang);
    try {
      await docService.updateDocument(accessToken, documentId, { language: newLang });
    } catch {
      // Silently tolerate — the language in the DB may be stale but the editor
      // already switched, and Phase 6's collaboration layer will synchronize it.
    }
  };

  // ── Manual save button ────────────────────────────────────────────────
  const handleManualSave = () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveContent(content);
  };

  // ── Status badge styling ──────────────────────────────────────────────
  const statusConfig = {
    saved: { text: 'Saved', className: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
    saving: { text: 'Saving…', className: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' },
    unsaved: { text: 'Unsaved', className: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20' },
    error: { text: 'Save failed', className: 'text-red-400 bg-red-500/10 border-red-500/20' },
  };
  const currentStatus = statusConfig[saveStatus] ?? statusConfig.unsaved;

  // ── Render ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <div className="size-8 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
          <span className="text-sm text-zinc-400">Loading document…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-zinc-950 gap-4">
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-6 py-4 text-sm text-red-400">
          {error}
        </div>
        <Link
          to="/dashboard"
          className="text-sm text-zinc-400 hover:text-white transition"
        >
          ← Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950">
      {/* ─── Top toolbar ──────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/60 backdrop-blur px-4 py-2 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/dashboard"
            className="grid size-8 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30 transition hover:bg-emerald-500/25"
            title="Back to Dashboard"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-4">
              <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
            </svg>
          </Link>

          <div className="min-w-0">
            <h1
              className="truncate text-sm font-semibold text-white"
              title={doc?.name}
            >
              {doc?.name ?? 'Untitled'}
            </h1>
            {doc?.owner && (
              <p className="truncate text-xs text-zinc-500">
                by {doc.owner.name}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Language selector — only owner can change */}
          <select
            id="editor-language-select"
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value)}
            disabled={doc?.role !== 'OWNER'}
            className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 outline-none transition focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {LANGUAGE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          {/* Save status badge */}
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${currentStatus.className}`}
          >
            {currentStatus.text}
          </span>

          {/* Save button */}
          {!isReadOnly && (
            <button
              id="editor-save-button"
              onClick={handleManualSave}
              disabled={saveStatus === 'saving' || saveStatus === 'saved'}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saveStatus === 'saving' ? 'Saving…' : 'Save'}
            </button>
          )}

          {/* Read-only indicator */}
          {isReadOnly && (
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
              Read-only
            </span>
          )}

          {/* Role badge */}
          {doc?.role && (
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs uppercase tracking-wider text-zinc-500">
              {doc.role}
            </span>
          )}
        </div>
      </header>

      {/* ─── Monaco Editor ────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        <Editor
          defaultValue={content}
          language={monacoLanguage(language)}
          theme="vs-dark"
          onChange={handleEditorChange}
          onMount={handleEditorDidMount}
          options={{
            readOnly: isReadOnly,
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
            fontLigatures: true,
            minimap: { enabled: true },
            lineNumbers: 'on',
            wordWrap: 'off',
            scrollBeyondLastLine: true,
            automaticLayout: true,
            tabSize: 2,
            renderWhitespace: 'selection',
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            smoothScrolling: true,
            bracketPairColorization: { enabled: true },
            padding: { top: 16 },
          }}
          loading={
            <div className="flex h-full items-center justify-center bg-zinc-950">
              <div className="flex flex-col items-center gap-3">
                <div className="size-6 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
                <span className="text-xs text-zinc-500">Loading editor…</span>
              </div>
            </div>
          }
        />
      </div>

      {/* ─── Status bar ───────────────────────────────────────────────── */}
      <footer className="flex items-center justify-between border-t border-zinc-800/80 bg-zinc-900/40 px-4 py-1.5 text-xs text-zinc-500 shrink-0">
        <div className="flex items-center gap-4">
          <span className="font-mono">{monacoLanguage(language)}</span>
          <span>UTF-8</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono">Phase 4 / 15</span>
          <span>Ctrl+S to save</span>
        </div>
      </footer>
    </div>
  );
}
