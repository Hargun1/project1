import { useRef, useState } from 'react';

/**
 * The document name in the editor toolbar. For the owner (§2.18, OWNER only on
 * the server) it is a button that turns into an input: Enter or leaving the
 * field saves, Escape cancels. Everyone else sees plain text.
 *
 * @param {object} props
 * @param {string} props.name
 * @param {boolean} props.canRename
 * @param {(name: string) => Promise<boolean>} props.onRename  resolves true on success
 */
export function DocumentTitle({ name, canRename, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  // Each edit ends exactly once. Disabling or removing a focused input can fire
  // blur in Chrome, which would otherwise send a second request after Enter, or
  // save the draft that Escape just discarded.
  const settled = useRef(false);

  const start = () => {
    settled.current = false;
    setDraft(name);
    setEditing(true);
  };

  const cancel = () => {
    settled.current = true;
    setEditing(false);
  };

  const finish = async () => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    if (!next || next === name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onRename(next);
    setSaving(false);
    if (ok) setEditing(false);
    else settled.current = false; // stay in the field so the user can retry
  };

  if (!canRename) {
    return (
      <h1 className="truncate text-sm font-semibold text-white" title={name}>
        {name}
      </h1>
    );
  }

  if (editing) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void finish();
        }}
      >
        <label htmlFor="document-title-input" className="sr-only">
          Document name
        </label>
        <input
          id="document-title-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void finish()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancel();
          }}
          onFocus={(event) => event.target.select()}
          disabled={saving}
          maxLength={255}
          // Focus follows the user's click on the title.
          autoFocus
          className="w-48 rounded border border-emerald-500 bg-zinc-900 px-1.5 py-0.5 text-sm font-semibold text-white outline-none sm:w-64"
        />
      </form>
    );
  }

  return (
    <h1 className="min-w-0">
      <button
        type="button"
        onClick={start}
        title="Rename"
        className="max-w-full truncate rounded px-1 -mx-1 text-left text-sm font-semibold text-white transition hover:bg-zinc-800"
      >
        {name}
      </button>
    </h1>
  );
}
