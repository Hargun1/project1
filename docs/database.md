# Database design

PostgreSQL 17, accessed through Prisma. Four tables. Table and column names are
snake_case via `@@map`/`@map`; the generated Prisma client stays camelCase.

Every timestamp is `timestamptz`, which needs `@db.Timestamptz(3)` in the schema —
Prisma's default `DateTime` maps to `timestamp` **without** time zone, storing a
wall-clock reading with no record of the offset it was taken in. Collaborators sit
in different zones, so "who edited this first" would otherwise depend on where the
writer happened to be.

Schema: [`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma).

## Tables

### `users`

| Column          | Type           | Notes                                     |
| --------------- | -------------- | ----------------------------------------- |
| `id`            | `uuid` PK      |                                           |
| `name`          | `varchar(100)` |                                           |
| `email`         | `varchar(255)` | `UNIQUE`                                  |
| `password_hash` | `text`         | Argon2id/bcrypt digest — never a password |
| `created_at`    | `timestamptz`  |                                           |
| `updated_at`    | `timestamptz`  |                                           |

The column is named `password_hash`, not `password`, on purpose: the name is the
first line of documentation, and it makes a plaintext write look obviously wrong
in review. The unique index on `email` is also the login lookup path.

### `documents`

| Column       | Type              | Notes               |
| ------------ | ----------------- | ------------------- |
| `id`         | `uuid` PK         |                     |
| `owner_id`   | `uuid` FK → users | `ON DELETE CASCADE` |
| `name`       | `varchar(255)`    |                     |
| `language`   | `varchar(32)`     | Monaco language id  |
| `deleted_at` | `timestamptz?`    | **Soft delete**     |
| `created_at` | `timestamptz`     |                     |
| `updated_at` | `timestamptz`     |                     |

Deletion is soft. A hard delete would cascade away revision history and
membership rows, which turns "I deleted the wrong file" into permanent data
loss. The cost is that **every read path must filter `deleted_at IS NULL`** —
forgetting it is the classic soft-delete bug, so the filter belongs in the
repository layer rather than being repeated in each handler.

Indexes:

- `(owner_id, deleted_at)` — "my documents", with deleted rows excluded, from
  the index alone.
- `(updated_at DESC)` — the dashboard's default "recently edited" ordering.
- `(language)` — the language filter.

### `document_members`

| Column        | Type                  | Notes                       |
| ------------- | --------------------- | --------------------------- |
| `document_id` | `uuid` FK → documents | `ON DELETE CASCADE`         |
| `user_id`     | `uuid` FK → users     | `ON DELETE CASCADE`         |
| `role`        | `Role` enum           | `OWNER \| EDITOR \| VIEWER` |
| `created_at`  | `timestamptz`         |                             |

The primary key is composite: `(document_id, user_id)`. That gives the
uniqueness the domain requires — a user has exactly one role per document — as a
database constraint rather than an application check, and the PK index is
precisely the lookup an authorization check performs. A surrogate `id` here would
add a column, add an index, and still need the unique constraint anyway.

`(user_id)` is indexed for the reverse direction, "documents shared with me".

`role` is a PostgreSQL enum mirroring the `Role` union in `@collab/shared`, so an
invalid role cannot be persisted even by a buggy code path.

### `document_revisions`

| Column            | Type                  | Notes                            |
| ----------------- | --------------------- | -------------------------------- |
| `id`              | `uuid` PK             |                                  |
| `document_id`     | `uuid` FK → documents | `ON DELETE CASCADE`              |
| `created_by`      | `uuid?` FK → users    | `ON DELETE SET NULL`             |
| `snapshot`        | `bytea`               | `Y.encodeStateAsUpdate()` output |
| `revision_number` | `integer`             | Per-document, gap-free           |
| `created_at`      | `timestamptz`         |                                  |

`snapshot` is **binary CRDT state, not text.** Text is a lossy projection of a
Y.Doc: it discards tombstones and client IDs, so a document restored from text
can no longer merge correctly with updates from a client that still holds the
old state. `bytea` costs some storage and makes rows unreadable in a SQL console;
correct restores are worth both.

`created_by` is nullable with `SET NULL` so revision history outlives a deleted
account. `CASCADE` there would erase the history of a shared document because one
contributor closed their account.

`UNIQUE (document_id, revision_number)` is what makes concurrent snapshot writers
safe: two processes computing revision _n_ race, one commits, the other gets a
unique violation and retries with _n+1_. Correctness comes from the constraint,
not from hoping only one writer exists.

`(document_id, created_at DESC)` serves "show this document's recent revisions".

## Relationships

```
users ──1:N──▶ documents            (owner_id, CASCADE)
users ──1:N──▶ document_members     (user_id,  CASCADE)
users ──1:N──▶ document_revisions   (created_by, SET NULL, nullable)

documents ──1:N──▶ document_members    (CASCADE)
documents ──1:N──▶ document_revisions  (CASCADE)
```

`users` ↔ `documents` is many-to-many through `document_members`, with the
`role` column as the relationship's payload.

## Migrations

Development:

```bash
npm run db:migrate
```

Production / CI deployment:

```bash
npm run db:deploy
```

Migration SQL is committed, so schema history is reviewable in the same diff as
the code that depends on it. `prisma migrate dev` is never run against a
deployed database — `deploy` applies existing migrations without generating or
resetting anything.

CLI configuration lives in `backend/prisma.config.js`. From Prisma 6 the CLI no
longer loads `.env` itself, and this repo keeps one `.env` at the root rather
than a copy per workspace, so that file points dotenv at the root before
`env("DATABASE_URL")` is resolved. It also replaces the deprecated
`package.json#prisma` key.

**Status:** one migration (`init`) is committed and applied. Verified against the
running container: 4 tables, the `Role` enum, the composite primary key on
`document_members`, `UNIQUE (document_id, revision_number)`, `snapshot BYTEA`,
`ON DELETE SET NULL` on `document_revisions.created_by`, and all 9 indexes.

## What is not in the schema yet

Refresh-token sessions, share links and audit rows arrive with the phases that
need them (2 and 10). Adding them now would mean tables no code reads, which is
indistinguishable from dead code.
