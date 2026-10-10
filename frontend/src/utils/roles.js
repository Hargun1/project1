/** Display labels for document roles (the API sends OWNER / EDITOR / VIEWER). */
export const ROLE_LABELS = { OWNER: 'Owner', EDITOR: 'Editor', VIEWER: 'Viewer' };

/**
 * @param {string | undefined} role
 * @returns {string}
 */
export function roleLabel(role) {
  return ROLE_LABELS[role] ?? role ?? '';
}
