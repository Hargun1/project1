import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { can } from '@collab/shared';
import { useAuth } from '../auth/useAuth.js';
import * as docService from '../services/document.service.js';
import { useToast } from '../toast/toast-context.js';
import { LANGUAGE_OPTIONS, languageFromFileName, languageLabel } from '../utils/languages.js';
import { roleLabel } from '../utils/roles.js';
import { formatRelative } from '../utils/time.js';

/** Ownership filter (§8, §32): everything, documents I own, documents shared with me. */
const OWNER_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'me', label: 'Owned by me' },
  { value: 'others', label: 'Shared with me' },
];

const FIELD =
  'rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-emerald-500';

/**
 * The signed-in home: create a document, find one, open or delete it.
 * Lists only documents the user is a member of (the server decides).
 */
export function DashboardPage() {
  const { getAccessToken } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const nameInput = useRef(null);

  const [documents, setDocuments] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState('');
  const [owner, setOwner] = useState('all');
  const [reloadKey, setReloadKey] = useState(0);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLanguage, setNewLanguage] = useState('javascript');
  // Once the user picks a language by hand, the file extension stops choosing it.
  const [languageChosen, setLanguageChosen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const res = await docService.listDocuments(await getAccessToken(), {
          page,
          search,
          language,
          owner,
        });
        if (cancelled) return;
        setDocuments(res.data);
        setMeta(res.meta);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, page, search, language, owner, reloadKey]);

  const handleNameChange = (value) => {
    setNewName(value);
    const inferred = languageFromFileName(value);
    if (inferred && !languageChosen) setNewLanguage(inferred);
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    if (!newName.trim()) return;
    try {
      setCreating(true);
      const res = await docService.createDocument(await getAccessToken(), {
        name: newName.trim(),
        language: newLanguage,
      });
      navigate(`/editor/${res.document.id}`);
    } catch (err) {
      toast.error(`Could not create the document: ${err.message}`);
      setCreating(false);
    }
  };

  const handleDelete = async (doc) => {
    if (!window.confirm(`Delete "${doc.name}"? Everyone with access will lose it.`)) return;
    try {
      await docService.deleteDocument(await getAccessToken(), doc.id);
      setDocuments((docs) => docs.filter((d) => d.id !== doc.id));
      setMeta((current) => (current ? { ...current, total: current.total - 1 } : current));
      toast.success(`Deleted "${doc.name}"`);
    } catch (err) {
      toast.error(`Could not delete "${doc.name}": ${err.message}`);
    }
  };

  const filtering = search !== '' || language !== '' || owner !== 'all';

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Your documents</h1>
          {meta && (
            <p className="mt-1 text-sm text-zinc-400">
              {meta.total} document{meta.total === 1 ? '' : 's'} you own or were invited to
            </p>
          )}
        </div>

        <form onSubmit={handleCreate} className="flex flex-wrap gap-2" aria-label="New document">
          <label htmlFor="new-document-name" className="sr-only">
            New document name
          </label>
          <input
            id="new-document-name"
            ref={nameInput}
            type="text"
            placeholder="New document name"
            value={newName}
            onChange={(e) => handleNameChange(e.target.value)}
            className={`${FIELD} min-w-0 flex-1 sm:w-56 sm:flex-none`}
            maxLength={255}
            required
          />
          <label htmlFor="new-document-language" className="sr-only">
            Language
          </label>
          <select
            id="new-document-language"
            value={newLanguage}
            onChange={(e) => {
              setNewLanguage(e.target.value);
              setLanguageChosen(true);
            }}
            className={FIELD}
          >
            {LANGUAGE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
      </div>

      <div className="space-y-3">
        <div
          className="inline-flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5 text-sm"
          role="group"
          aria-label="Show documents"
        >
          {OWNER_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={owner === value}
              onClick={() => {
                setOwner(value);
                setPage(1);
              }}
              className={`rounded px-3 py-1.5 transition ${
                owner === value ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row" role="search">
          <label htmlFor="document-search" className="sr-only">
            Search documents
          </label>
          <input
            id="document-search"
            type="search"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className={`${FIELD} w-full sm:max-w-sm`}
          />
          <label htmlFor="document-language-filter" className="sr-only">
            Filter by language
          </label>
          <select
            id="document-language-filter"
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value);
              setPage(1);
            }}
            className={FIELD}
          >
            <option value="">All languages</option>
            {LANGUAGE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-36 animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/50"
            />
          ))}
          <span className="sr-only">Loading documents…</span>
        </div>
      ) : error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300"
        >
          <span>Could not load your documents: {error}</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="rounded-md border border-red-500/30 px-3 py-1 text-red-200 transition hover:bg-red-500/10"
          >
            Try again
          </button>
        </div>
      ) : documents.length === 0 ? (
        <EmptyState
          filtering={filtering}
          onCreate={() => nameInput.current?.focus()}
          onClear={() => {
            setSearch('');
            setLanguage('');
            setOwner('all');
          }}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className="group flex min-w-0 flex-col justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 transition hover:border-zinc-700 hover:bg-zinc-900"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <Link
                    to={`/editor/${doc.id}`}
                    className="min-w-0 truncate font-mono text-base font-medium text-zinc-100 group-hover:text-emerald-300"
                    title={doc.name}
                  >
                    {doc.name}
                  </Link>
                  <span className="shrink-0 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                    {languageLabel(doc.language)}
                  </span>
                </div>
                <p className="mt-3 text-xs text-zinc-400">
                  {doc.role === 'OWNER'
                    ? 'You own this'
                    : `${roleLabel(doc.role)} · shared by ${doc.owner?.name ?? 'someone'}`}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Edited{' '}
                  <time dateTime={doc.updatedAt} title={new Date(doc.updatedAt).toLocaleString()}>
                    {formatRelative(doc.updatedAt)}
                  </time>
                </p>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-zinc-800 pt-3">
                <Link
                  to={`/editor/${doc.id}`}
                  className="text-sm text-zinc-300 transition hover:text-white"
                >
                  Open →
                </Link>
                {can(doc.role, 'document:delete') && (
                  <button
                    type="button"
                    onClick={() => handleDelete(doc)}
                    className="text-sm text-zinc-500 transition hover:text-red-400"
                    aria-label={`Delete ${doc.name}`}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {meta && meta.totalPages > 1 && (
        <nav className="flex items-center gap-3 text-sm text-zinc-400" aria-label="Pages">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-40"
          >
            Previous
          </button>
          <span>
            Page {page} of {meta.totalPages}
          </span>
          <button
            type="button"
            disabled={page >= meta.totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}

function EmptyState({ filtering, onCreate, onClear }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-14 text-center">
      <div
        aria-hidden="true"
        className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-zinc-900 font-mono text-emerald-300 ring-1 ring-zinc-800"
      >
        {'{ }'}
      </div>
      {filtering ? (
        <>
          <p className="font-medium text-zinc-200">No documents match</p>
          <p className="mt-1 text-sm text-zinc-500">Try another name or language.</p>
          <button
            type="button"
            onClick={onClear}
            className="mt-5 rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition hover:bg-zinc-800"
          >
            Clear filters
          </button>
        </>
      ) : (
        <>
          <p className="font-medium text-zinc-200">No documents yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
            Create one, then share it from the editor to edit it together in real time.
          </p>
          <button
            type="button"
            onClick={onCreate}
            className="mt-5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
          >
            Create a document
          </button>
        </>
      )}
    </div>
  );
}
