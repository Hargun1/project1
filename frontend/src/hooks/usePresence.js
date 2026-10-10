import { useEffect, useState } from 'react';

/**
 * Who is in the document, derived from Yjs awareness (§20, §30).
 *
 * Awareness emits `change` on every remote cursor move. Copying that into React
 * state each time would re-render the page whenever anyone moves their caret,
 * so the hook only updates when the *set of collaborators* changes — someone
 * joins, leaves, or a name/colour changes. Cursor positions never enter React:
 * y-monaco draws them directly as editor decorations.
 *
 * @param {import('y-protocols/awareness').Awareness | null} awareness
 * @returns {{ clientID: number, user: { id: string, name: string, color: string }, isLocal: boolean }[]}
 */
export function usePresence(awareness) {
  const [collaborators, setCollaborators] = useState([]);

  useEffect(() => {
    if (!awareness) {
      setCollaborators([]);
      return undefined;
    }

    let lastKey = '';
    const recompute = () => {
      const next = [...awareness.getStates()]
        .filter(([, state]) => state?.user)
        .map(([clientID, state]) => ({
          clientID,
          user: state.user,
          isLocal: clientID === awareness.clientID,
        }))
        .sort((a, b) => a.clientID - b.clientID);

      const key = next
        .map((c) => `${c.clientID}:${c.user.id}:${c.user.name}:${c.user.color}`)
        .join('|');
      if (key !== lastKey) {
        lastKey = key;
        setCollaborators(next);
      }
    };

    recompute();
    awareness.on('change', recompute);
    return () => awareness.off('change', recompute);
  }, [awareness]);

  return collaborators;
}

/**
 * Collapse several tabs of the same person into one entry for display.
 *
 * @param {ReturnType<typeof usePresence>} collaborators
 * @returns {{ user: object, tabs: number, isYou: boolean }[]} you first, then by name
 */
export function groupByUser(collaborators) {
  const byUser = new Map();
  for (const { user, isLocal } of collaborators) {
    const entry = byUser.get(user.id) ?? { user, tabs: 0, isYou: false };
    entry.tabs += 1;
    entry.isYou ||= isLocal;
    byUser.set(user.id, entry);
  }
  return [...byUser.values()].sort(
    (a, b) => Number(b.isYou) - Number(a.isYou) || a.user.name.localeCompare(b.user.name),
  );
}
