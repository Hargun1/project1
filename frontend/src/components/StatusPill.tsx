import type { PillTone } from './status-tone';

const TONE_CLASSES: Record<PillTone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  down: 'bg-red-500/10 text-red-300 ring-red-500/30',
  idle: 'bg-zinc-500/10 text-zinc-400 ring-zinc-500/30',
};

const DOT_CLASSES: Record<PillTone, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  down: 'bg-red-400',
  idle: 'bg-zinc-500',
};

interface StatusPillProps {
  tone: PillTone;
  label: string;
}

export function StatusPill({ tone, label }: StatusPillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      <span className={`size-1.5 rounded-full ${DOT_CLASSES[tone]}`} aria-hidden="true" />
      {label}
    </span>
  );
}
