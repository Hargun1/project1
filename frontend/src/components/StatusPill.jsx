const TONE_CLASSES = {
  ok: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  down: 'bg-red-500/10 text-red-300 ring-red-500/30',
  idle: 'bg-zinc-500/10 text-zinc-400 ring-zinc-500/30',
};

const DOT_CLASSES = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  down: 'bg-red-400',
  idle: 'bg-zinc-500',
};

/**
 * @param {object} props
 * @param {string} props.tone one of PILL_TONES from ./status-tone.js
 * @param {string} props.label
 */
export function StatusPill({ tone, label }) {
  // Falling back rather than indexing blindly: an unknown tone would otherwise
  // produce `undefined` in the class string and a pill with no styling.
  const toneClass = TONE_CLASSES[tone] ?? TONE_CLASSES.idle;
  const dotClass = DOT_CLASSES[tone] ?? DOT_CLASSES.idle;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${toneClass}`}
    >
      <span className={`size-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
      {label}
    </span>
  );
}
