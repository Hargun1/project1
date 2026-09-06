import { Link } from 'react-router-dom';

interface PlaceholderPageProps {
  title: string;
  phase: string;
  description: string;
}

/**
 * Honest placeholder for a route that exists in the router but whose feature has
 * not been built yet, so navigating never lands on a blank screen.
 */
export function PlaceholderPage({ title, phase, description }: PlaceholderPageProps) {
  return (
    <div className="mx-auto max-w-lg rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
      <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">{phase}</p>
      <h1 className="mt-3 text-xl font-semibold text-white">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">{description}</p>
      <Link
        to="/"
        className="mt-6 inline-flex rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
      >
        Back to status
      </Link>
    </div>
  );
}
