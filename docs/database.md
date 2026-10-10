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

| Column          | Type           | Notes                                      |
| --------------- | -------------- | ------------------------------------------ |
| `id`            | `uuid` PK      |                                            |
| `name`          | `varchar(100)` |                                            |
| `email`         | `varchar(255)` | `UNIQUE`                                   |
| `password_hash` | `text`         | bcrypt digest (cost 12) — never a password |
| `created_at`    | `timestamptz`  |                                            |
| `updated_at`    | `timestamptz`  |                                            |

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
| `yjs_state`  | `bytea?`          | Current CRDT state  |
| `deleted_at` | `timestamptz?`    | **Soft delete**     |
| `created_at` | `timestamptz`     |                     |
| `updated_at` | `timestamptz`     |                     |

Deletion is soft. A hard delete would cascade away revision history and
membership rows, which turns "I deleted the wrong file" into permanent data
loss. The cost is that **every read path must filter `deleted_at IS NULL`** —
forgetting it is the classic soft-delete bug, so the filter belongs in the
repository layer rather than being repeated in each handler.

`yjs_state` is the live document: `Y.encodeStateAsUpdate()` output, overwritten
by a debounced save while the document is edited and loaded when it is next
opened. `NULL` means "never edited". It is excluded from every metadata query
(Prisma `omit`), so listing documents never drags CRDT state through the
dashboard. History is a separate, append-only table (below); see
[collaboration.md](collaboration.md#persistence) for why current state and
history are kept apart, and why neither is stored as text.

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

| Column                 | Type                  | Notes                              |
| ---------------------- | --------------------- | ---------------------------------- |
| `id`                   | `uuid` PK             |                                    |
| `document_id`          | `uuid` FK → documents | `ON DELETE CASCADE`                |
| `created_by`           | `uuid?` FK → users    | `ON DELETE SET NULL`               |
| `snapshot`             | `bytea`               | `Y.encodeStateAsUpdate()` output   |
| `revision_number`      | `integer`             | Per-document, gap-free             |
| `kind`                 | `RevisionKind` enum   | `AUTO \| MANUAL \| RESTORE`        |
| `restored_from_number` | `integer?`            | For `RESTORE`: the source revision |
| `created_at`           | `timestamptz`         |                                    |

`snapshot` is **binary CRDT state, not text.** Text is a lossy projection of a
Y.Doc: it discards tombstones and client IDs, so a document restored from text
can no longer merge correctly with updates from a client that still holds the
old state. `bytea` costs some storage and makes rows unreadable in a SQL console;
correct restores are worth both.

`created_by` is nullable with `SET NULL` so revision history outlives a deleted
account. `CASCADE` there would erase the history of a shared document because one
contributor closed their account.

Revisions are inserted inside the same transaction that saves the live state,
while holding a `SELECT … FOR UPDATE` lock on the document row. That serialises
writers across backend instances, so revision _n + 1_ is always computed from
the committed revision _n_. `UNIQUE (document_id, revision_number)` stays as the
backstop: if a future code path forgot the lock, a duplicate number would fail
loudly rather than corrupt history.

`restored_from_number` is a number rather than a foreign key: revision numbers
are immutable per document, and revision rows are never deleted on their own.
How revisions are created and why restore is implemented as new operations
rather than "apply the old snapshot" is in
[collaboration.md](collaboration.md#revision-history-and-restore-25).

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

**Status:** three migrations are committed and applied: `init`,
`document_yjs_state` (adds `documents.yjs_state`) and `revision_kind` (adds the
`RevisionKind` enum, `kind` and `restored_from_number`). For `init`, verified
against the running container: 4 tables, the `Role` enum, the composite primary key on
`document_members`, `UNIQUE (document_id, revision_number)`, `snapshot BYTEA`,
`ON DELETE SET NULL` on `document_revisions.created_by`, and all 9 indexes.

## What is deliberately not in the schema

- **Refresh sessions and WebSocket tickets** live in Redis with a TTL, not in
  tables: they are short-lived, must expire on their own, and are consumed
  atomically with `GETDEL`.
- **Share links and audit rows** were never needed by a feature, so they were
  not built. A table no code reads is dead code.
