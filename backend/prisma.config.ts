import path from 'node:path';
import { defineConfig } from 'prisma/config';
import dotenv from 'dotenv';

// The Prisma CLI does not read .env files on its own from Prisma 6 onward, and
// this monorepo keeps a single .env at the root rather than one per workspace —
// so point dotenv at it explicitly before the schema's env("DATABASE_URL") is
// resolved. This file also replaces the deprecated `package.json#prisma` key.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
});
