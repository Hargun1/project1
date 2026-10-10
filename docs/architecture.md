# Architecture

This document explains _why_ the system is shaped the way it is. Where a
decision is not yet implemented, it is marked with the phase that implements it,
so nothing here reads as a claim about working code.

## The problem

Two people type in the same file at the same time. Alice inserts `x` at offset 5
while Bob deletes offset 3. Both edits are valid; both were made against the
same starting state; neither user should see a conflict dialog, and neither edit
should be lost. After the messages cross the network in either order, both
screens must show the same characters.

Everything below follows from that requirement.

## Why a CRDT and not operational transforms or locks

Three approaches were considered:

| Approach                   | Why not / why yes                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Locking** (one writer)   | Trivially correct, but it is not collaborative editing. It also breaks badly on a dropped connection: the lock outlives the editor.                                                                                                     |
| **Operational transforms** | Correct and battle-tested (Google Docs), but it requires a central authority that serialises and rewrites every operation. That authority is a single point of coordination and a large amount of subtle, hand-written transform logic. |
| **CRDT (chosen: Yjs)**     | Operations are commutative by construction: applying them in any order converges. The server does not need to transform anything, which means the server does not need to be the single ordering authority.                             |

The consequence that matters architecturally: **because merging is
order-independent, the backend is not a coordinator.** It is a relay plus a
persistence layer. That is what makes running several backend instances behind a
load balancer tractable.

The cost is real and worth stating in an interview: CRDT documents carry
metadata (client IDs, tombstones for deleted characters) so state is larger than
the text it represents, and the merge result — while always convergent — is not
always what a human would have chosen for overlapping edits to the same word.

## Update flow (implemented in Phase 6, except Redis)

```
Alice types
    │
    ▼
Monaco onDidChangeModelContent
    │  y-monaco binding
    ▼
Y.Text mutation → Y.Doc 'update' event  (a small binary delta, not the file)
    │
    ▼  WebSocket send (JSON envelope, base64 payload)
Backend instance A
    │
    ├──▶ refuse if the sender is a VIEWER
    ├──▶ apply to the in-memory Y.Doc for this document
    ├──▶ forward to the other sockets on instance A
    ├──▶ PUBLISH to Redis              ──▶ instance B ──▶ its sockets
    └──▶ schedule a debounced save     ──▶ documents.yjs_state
```

Protocol, reconnection and save-status details: [collaboration.md](collaboration.md).

The payload is always an incremental Yjs update. Sending the whole document per
keystroke would make bandwidth grow with file size × typing speed, and would
also destroy the property that makes concurrent edits merge — a whole-document
write is a last-writer-wins overwrite.

## Why Redis Pub/Sub, and what it is not

With more than one backend instance, Alice's socket may be served by instance A
and Bob's by instance B. Neither instance sees the other's traffic. Redis
Pub/Sub carries updates between them: each instance subscribes to the channels
for documents it currently has open, and publishes updates it receives.

Pub/Sub is fire-and-forget: a message published while an instance is
disconnected is simply gone. That is acceptable **only** because Redis is not
the source of truth. Instances re-run a state-vector handshake with each other
whenever they (re)subscribe, so missed messages are recovered, and saves merge
into PostgreSQL under a row lock, so instances that diverged cannot overwrite
each other. Using Redis as document storage would mean a `FLUSHALL` or an
eviction is data loss.

Implemented in Phase 8 and verified with two real backend processes, including
stopping Redis mid-session; details in [scaling.md](scaling.md). Since Phase 12
the instances run behind Nginx in Docker; see [deployment.md](deployment.md).

## Why PostgreSQL stores binary snapshots

The live document (`documents.yjs_state`, Phase 6) and every revision
(`document_revisions.snapshot`, Phase 9) hold `Y.encodeStateAsUpdate(doc)` in a
`BYTEA` column, not rendered text. Text is a _projection_ of CRDT state: it discards tombstones and
client IDs. Restoring from text would produce a document that can no longer
merge correctly with an old client's updates, and would silently resurrect
deleted characters in some orderings.

Snapshots are written on a debounce (default 2 s of idleness) rather than per
update, because a keystroke-rate write pattern would make the database the
bottleneck for a workload that does not need durability at that granularity.
The trade-off is an explicit bounded loss window: up to
`DOC_SNAPSHOT_MAX_WAIT_MS` (10 s) of edits can be lost from the server if the
process is killed mid-window, and connected clients re-upload them on
reconnect. Revision history (Phase 9) is append-only; restoring writes new
operations, because re-applying an old CRDT snapshot changes nothing — see
[collaboration.md](collaboration.md#revision-history-and-restore-25).

## Authentication boundary (Phases 2, 5)

Two token types with different lifetimes:

- A short-lived **access token** (JWT) sent on API requests.
- A long-lived **refresh token** in an `HttpOnly`, `Secure`, `SameSite` cookie,
  rotated on use. It is a cookie, not `localStorage`, because JavaScript must not
  be able to read it — that is what limits the blast radius of an XSS bug.

WebSockets get their own mechanism. Browsers cannot set headers on a WebSocket
handshake, so the naive fix is `wss://…?token=<JWT>`. That is rejected here:
URLs land in access logs, proxy logs and browser history. Instead the client
calls an authenticated endpoint to mint a **single-use, short-TTL ticket** stored
in Redis, and connects with `?ticket=…`. The server consumes the ticket
atomically — a replayed ticket fails.

## Authorization (Phase 10)

Roles are a constant list (`OWNER | EDITOR | VIEWER`) defined once in
`@collab/shared` and mirrored by a Prisma enum, so the client, the server and the
database cannot disagree about what a role is.

Because the project is plain JavaScript, that agreement is not enforced by a
compiler — it is enforced at runtime by `isRole()`, and by the Prisma enum, which
rejects an invalid value at the database boundary even if application code lets
one through.

What each role may do is one table, `PERMISSIONS`, with one function, `can(role,
action)`, in `shared/src/permissions.js`. The server uses it to enforce; the
frontend uses the same function only to decide which buttons to show. `can()`
throws on an unknown action, so a typo fails loudly instead of silently denying.

Every check happens on the server, at three points:

1. **REST:** every per-document request goes through `requirePermission`
   (`backend/src/services/access.service.js`), which reads the caller's role
   from PostgreSQL on each request — never from the token — and applies `can()`.
2. **WebSocket, per message:** an edit from a socket whose role cannot
   `document:edit` is refused. Hiding the editor in the UI is a UX affordance,
   not a security control; a `VIEWER` who opens a socket by hand is still refused.
3. **WebSocket, over time (§42):** when an owner changes a role, removes a
   member or deletes the document, every instance is told (Redis channel
   `access-changes`) to re-check the affected sockets against PostgreSQL: a
   downgrade takes effect live, a removal closes the socket with `4003`, a
   deletion with `4004`. The announcement carries no role, so a lost or forged
   one cannot grant anything; each socket also re-checks every 60 s, which
   bounds how long a lost announcement can delay a revocation.

## Request lifecycle (implemented)

```
request
  → request-id middleware      (reuse a safe inbound x-request-id, else a UUID)
  → helmet, CORS, body limit
  → pino-http                  (structured log; /healthz and /readyz excluded)
  → route handler
  → error handler              (AppError | ZodError | body-parser | unknown)
       → typed { error: { code, message, details?, requestId } }
```

Every response carries `x-request-id`, and error bodies repeat it. A user can
quote the id from a failure and it pins the exact log line — without the log
containing the authorization header, cookie or password, all of which are
stripped by pino's redaction config.

`createApp()` returns an Express app and never calls `listen()`. Tests drive it
with supertest and no open port, and Phase 5 can attach a `ws` server to the same
HTTP server that Express is mounted on.

## Configuration

One `.env` at the repository root, consumed by Docker Compose, the backend
(dotenv) and Vite (`envDir`). The backend parses it with Zod at startup and
exits with a list of every offending variable if anything is missing or
malformed. Fail-fast beats discovering a missing `DATABASE_URL` as an
`undefined` three layers into a request handler. Validation lives in a pure
schema module so it can be unit-tested without triggering `process.exit`.

## What is deliberately excluded

No microservices, no Kubernetes, no in-editor code execution, and no AI
features. Each would add operational surface without making the collaboration
problem — the actual subject of this project — any better solved. A single
well-understood Express service that scales horizontally is a stronger claim
than a distributed system that cannot be explained.
