import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-lg text-center">
      <p className="font-mono text-6xl font-semibold text-zinc-800">404</p>
      <h1 className="mt-4 text-xl font-semibold text-white">Page not found</h1>
      <p className="mt-2 text-sm text-zinc-400">That route does not exist in the client.</p>
      <Link
        to="/"
        className="mt-6 inline-flex rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
      >
        Back to status
      </Link>
    </div>
  );
}
