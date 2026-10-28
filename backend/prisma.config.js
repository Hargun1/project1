import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';
import dotenv from 'dotenv';

// The Prisma CLI does not read .env files on its own from Prisma 6 onward, and
// this monorepo keeps a single .env at the root rather than one per workspace —
// so point dotenv at it explicitly before the schema's env("DATABASE_URL") is
// resolved. This file also replaces the deprecated `package.json#prisma` key.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../.env.local') });
dotenv.config({ path: path.resolve(here, '../.env') });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  // CLI migrations use the direct Neon endpoint; runtime keeps the pooled URL.
  ...(process.env.DATABASE_URL_UNPOOLED
    ? { engine: 'classic', datasource: { url: process.env.DATABASE_URL_UNPOOLED } }
    : {}),
});
