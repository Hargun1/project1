/**
 * CSS for remote cursors and selections drawn by y-monaco.
 *
 * y-monaco decorates a remote selection with `yRemoteSelection-<clientID>` and
 * its caret with `yRemoteSelectionHead-<clientID>`, but leaves colouring to the
 * app. Colours and name labels differ per collaborator, so the rules are
 * generated at runtime from awareness state.
 *
 * Awareness state is written by *other users' browsers*, and the name ends up
 * inside a CSS string. Unescaped, a display name such as
 * `"}body{display:none}` would break out of the string and restyle the page —
 * CSS injection. So every value is constrained before it is interpolated:
 *
 *   clientID → must be a non-negative integer
 *   color    → must be `#rrggbb`
 *   name     → every character outside [A-Za-z0-9 ] is written as a CSS hex escape
 *
 * (The server also validates awareness state; this is defence in depth, because
 * a browser must not have to trust a server to keep its own page intact.)
 */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FALLBACK_COLOR = '#a1a1aa';
const MAX_LABEL_LENGTH = 40;

/**
 * Escape a string for use inside a double-quoted CSS string.
 *
 * `\\<hex> ` is CSS's code-point escape; the trailing space terminates it. That
 * covers quotes, backslashes, newlines and anything else unusual.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeCssString(value) {
  let out = '';
  for (const char of value) {
    out += /[A-Za-z0-9 ]/.test(char) ? char : `\\${char.codePointAt(0).toString(16)} `;
  }
  return out;
}

/**
 * @param {{ clientID: number, color: unknown, name: unknown }[]} cursors
 * @returns {string} CSS rules for every valid entry
 */
export function buildCursorCss(cursors) {
  return cursors
    .filter(({ clientID }) => Number.isSafeInteger(clientID) && clientID >= 0)
    .map(({ clientID, color, name }) => {
      const safeColor = typeof color === 'string' && HEX_COLOR.test(color) ? color : FALLBACK_COLOR;
      const label = escapeCssString(
        typeof name === 'string' ? name.slice(0, MAX_LABEL_LENGTH) : 'Anonymous',
      );
      return [
        `.yRemoteSelection-${clientID} { background-color: ${safeColor}40; }`,
        `.yRemoteSelectionHead-${clientID} { border-color: ${safeColor}; }`,
        `.yRemoteSelectionHead-${clientID}::after { content: "${label}"; background-color: ${safeColor}; }`,
      ].join('\n');
    })
    .join('\n');
}
