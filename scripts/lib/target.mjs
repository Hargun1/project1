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
