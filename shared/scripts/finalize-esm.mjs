// The ESM build emits `.js` files, and this package has no top-level
// `"type": "module"` (the CommonJS build needs the default). Node and bundlers
// decide a `.js` file's module format from the nearest package.json, so
// `dist/esm` gets its own one-line manifest saying "everything in here is ESM".
//
// This is the standard dual-format trick; the alternative is emitting `.mjs`,
// which tsc cannot do without renaming every output file.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'dist', 'esm');

await mkdir(target, { recursive: true });
await writeFile(
  path.join(target, 'package.json'),
  `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
  'utf8',
);
