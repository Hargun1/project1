// Which running stack the scripts test, shared by every scripts/*.mjs test.
//
//   node scripts/smoke-stack.mjs                       → https://localhost:8443
//   node scripts/smoke-stack.mjs https://editor.example.com
//   STACK_URL=https://editor.example.com npm run stack:smoke

export const BASE = (process.argv[2] ?? process.env.STACK_URL ?? 'https://localhost:8443').replace(
  /\/$/,
  '',
);
export const WS_BASE = BASE.replace(/^http/, 'ws');
export const IS_LOCAL = ['localhost', '127.0.0.1'].includes(new URL(BASE).hostname);

// The local stack's certificate is self-signed unless a real one is mounted
// (nginx/40-tls.sh). Accept it for localhost only; against any other host,
// certificates are verified as usual. Node prints a warning about this once.
if (IS_LOCAL && BASE.startsWith('https:')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * Print one check's result. In GitHub Actions a failure is also emitted as an
 * `::error::` annotation, so the failing check is visible on the run page (and
 * through the public API) without opening the logs.
 *
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 * @returns {boolean} ok
 */
export function report(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS === 'true') {
    const message = `${label}${detail ? ` (${detail})` : ''}`
      .replace(/%/g, '%25')
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A');
    console.log(`::error::${message}`);
  }
  return ok;
}
