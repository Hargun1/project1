const MAX_AVATARS = 5;

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase() || '?';
}

/**
 * Avatar stack for the editor toolbar.
 *
 * Names are rendered as React text, which React escapes — no HTML from
 * awareness state ever reaches the DOM as markup.
 *
 * @param {{ people: { user: { id: string, name: string, color: string }, tabs: number, isYou: boolean }[] }} props
 */
export function CollaboratorAvatars({ people }) {
  const shown = people.slice(0, MAX_AVATARS);
  const hidden = people.length - shown.length;

  return (
    <div className="flex items-center -space-x-1.5" aria-label={`${people.length} people here`}>
      {shown.map(({ user, tabs, isYou }) => (
        <span
          key={user.id}
          title={`${user.name}${isYou ? ' (you)' : ''}${tabs > 1 ? ` · ${tabs} tabs` : ''}`}
          className="grid size-7 place-items-center rounded-full bg-zinc-900 text-[10px] font-semibold text-zinc-100 ring-2"
          style={{ '--tw-ring-color': user.color }}
        >
          {initials(user.name)}
        </span>
      ))}
      {hidden > 0 && (
        <span className="grid size-7 place-items-center rounded-full bg-zinc-800 text-[10px] text-zinc-300 ring-2 ring-zinc-700">
          +{hidden}
        </span>
      )}
    </div>
  );
}

/**
 * "Active collaborators" list for the status bar (§20).
 *
 * @param {{ people: { user: { id: string, name: string, color: string }, isYou: boolean }[] }} props
 */
export function CollaboratorList({ people }) {
  if (people.length === 0) return null;
  return (
    <ul
      className="flex min-w-0 items-center gap-3 overflow-hidden"
      aria-label="Active collaborators"
    >
      {people.map(({ user, isYou }) => (
        <li key={user.id} className="flex shrink-0 items-center gap-1.5">
          <span
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: user.color }}
            aria-hidden="true"
          />
          <span className={isYou ? 'text-zinc-300' : undefined}>
            {user.name}
            {isYou ? ' (you)' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
