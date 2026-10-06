import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';
import * as docService from '../services/document.service.js';

export function DashboardPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [documents, setDocuments] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState('');

  // form state
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLanguage, setNewLanguage] = useState('javascript');

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await docService.listDocuments(accessToken, { page, search, language });
        setDocuments(res.data);
        setMeta(res.meta);
        setError(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [accessToken, page, search, language]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      setCreating(true);
      const res = await docService.createDocument(accessToken, { name: newName, language: newLanguage });
      navigate(`/editor/${res.document.id}`);
    } catch (err) {
      alert(`Error: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this document?')) return;
    try {
      await docService.deleteDocument(accessToken, id);
      setDocuments((docs) => docs.filter((d) => d.id !== id));
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">Your Documents</h1>
        
        <form onSubmit={handleCreate} className="flex gap-2">
          <input
            type="text"
            placeholder="New document name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-white outline-none focus:border-emerald-500"
            required
          />
          <select 
            value={newLanguage}
            onChange={(e) => setNewLanguage(e.target.value)}
            className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-white outline-none focus:border-emerald-500"
          >
            <option value="javascript">JavaScript</option>
            <option value="typescript">TypeScript</option>
            <option value="python">Python</option>
            <option value="java">Java</option>
            <option value="cpp">C++</option>
            <option value="html">HTML</option>
            <option value="css">CSS</option>
            <option value="json">JSON</option>
          </select>
          <button
            type="submit"
            disabled={creating}
            className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
        </form>
      </div>

      <div className="flex gap-4">
        <input
          type="text"
          placeholder="Search documents..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-white outline-none focus:border-emerald-500 w-full max-w-sm"
        />
        <select 
          value={language}
          onChange={(e) => { setLanguage(e.target.value); setPage(1); }}
          className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-white outline-none focus:border-emerald-500"
        >
          <option value="">All languages</option>
          <option value="javascript">JavaScript</option>
          <option value="typescript">TypeScript</option>
          <option value="python">Python</option>
          <option value="java">Java</option>
          <option value="cpp">C++</option>
          <option value="html">HTML</option>
          <option value="css">CSS</option>
          <option value="json">JSON</option>
        </select>
      </div>

      {loading ? (
        <div className="text-zinc-500 text-sm">Loading documents...</div>
      ) : error ? (
        <div className="text-red-400 text-sm">{error}</div>
      ) : documents.length === 0 ? (
        <div className="text-zinc-500 text-sm border border-zinc-800 rounded-lg p-8 text-center bg-zinc-900/50">
          No documents found. Create one to get started.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {documents.map((doc) => (
            <div key={doc.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between">
                  <Link to={`/editor/${doc.id}`} className="text-lg font-medium text-emerald-400 hover:underline truncate">
                    {doc.name}
                  </Link>
                  <span className="text-xs uppercase tracking-wider text-zinc-500 bg-zinc-800 px-2 py-1 rounded">
                    {doc.language}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-2">
                  Role: <span className="text-zinc-300">{doc.role}</span>
                </p>
                <p className="text-xs text-zinc-400 mt-1">
                  Owner: {doc.owner?.name}
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  Updated {new Date(doc.updatedAt).toLocaleDateString()}
                </p>
              </div>
              
              <div className="mt-4 pt-4 border-t border-zinc-800 flex justify-between items-center">
                <Link to={`/editor/${doc.id}`} className="text-sm text-zinc-300 hover:text-white">
                  Open
                </Link>
                {doc.role === 'OWNER' && (
                  <button onClick={() => handleDelete(doc.id)} className="text-sm text-red-400 hover:text-red-300">
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {meta && meta.totalPages > 1 && (
        <div className="flex gap-2 items-center text-sm mt-4 text-zinc-400">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white"
          >
            Prev
          </button>
          <span>Page {page} of {meta.totalPages}</span>
          <button
            disabled={page >= meta.totalPages}
            onClick={() => setPage(p => p + 1)}
            className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
