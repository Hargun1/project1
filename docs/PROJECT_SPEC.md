# Real-Time Collaborative Code Editor — Project Specification

> Canonical spec, captured 2026-09-06. This file is the contract for the build.
> Implementation must follow the phase order in §48 / "Development Order" strictly.

---

## 1. Project Goal

Build a production-style, browser-based collaborative code editor similar to a combination of
VS Code Live Share and Google Docs. Multiple authenticated users should be able to open the same
code document and edit it simultaneously in real time.

The application must demonstrate:

- Full-stack development
- Real-time communication
- Concurrent editing
- CRDT-based synchronization
- Authentication and authorization
- Redis-based distributed WebSocket communication
- PostgreSQL persistence
- Horizontal backend scaling
- Dockerized development/deployment
- Testing
- Production-oriented security
- End-to-end type safety

This is intended to be a serious software-engineering portfolio project, not a simple CRUD application.

## 2. Core User Experience

A user should be able to:

1. Register an account.
2. Login securely.
3. See their documents.
4. Create a new code document.
5. Select a programming language.
6. Open the editor.
7. Edit code using Monaco Editor.
8. Invite other users to the document.
9. Assign roles: Owner / Editor / Viewer.
10. Have multiple users edit the same document simultaneously.
11. See other users' presence.
12. See other users' cursors/selections where practical.
13. See changes immediately without refreshing.
14. Disconnect and reconnect without corrupting the document.
15. Save document state.
16. View revision history.
17. Restore an older revision if authorized.
18. Delete/rename documents if authorized.
19. Search and filter documents.
20. Logout securely.

## 3. Technology Stack — Frontend

- React
- TypeScript
- Vite
- Monaco Editor (ships its own types)
- Yjs (ships its own types)
- WebSocket client
- React Router
- A lightweight state-management solution where needed
- CSS/Tailwind or another consistent styling solution

Do not over-engineer the frontend. The UI should be clean, responsive and professional.

**Why TypeScript here specifically:** this project's hardest bugs live at boundaries — WebSocket
message shapes, role/permission strings, Yjs's own typed API. TypeScript catches a shape mismatch
between client and server at compile time instead of silently failing mid-collaboration-session.
Learn it as part of building this, not before — the compiler teaches the system's shape as you go.

## 4. Backend

- Node.js
- TypeScript
- Express.js (with `@types/express`)
- `ws` for WebSocket communication (with `@types/ws`)
- JWT authentication
- bcrypt/Argon2 for password hashing
- PostgreSQL
- Redis
- ORM/query layer such as Prisma (generates types from schema automatically — strongly preferred
  over raw SQL here, since it gives type-safe queries for free)
- Zod for runtime validation of anything crossing a trust boundary (REST bodies, WebSocket
  messages, env vars) — TypeScript types disappear at runtime, so Zod is what actually protects
  against malformed input, and its inferred types double as the TS types

Separate the backend into logical layers:

```text
routes
controllers
services
repositories
middleware
websocket
auth
database
redis
utils
types        <- shared TS types/interfaces (roles, message envelopes, DTOs)
```

Do not put business logic directly inside route handlers.

Share types between frontend and backend via a small `shared/` or `packages/types` workspace
(npm/pnpm workspaces) so a WebSocket message type is defined once and imported by both sides —
this is where TypeScript pays off the most in this project.

## 5. Infrastructure

PostgreSQL, Redis, Docker, Docker Compose, Nginx, GitHub Actions, AWS.

Kubernetes is optional and must NOT be required for the first production version.

## 6. High-Level Architecture

```text
                         INTERNET
                            |
                            v
                    ┌───────────────┐
                    │    NGINX      │
                    │ Load Balancer │
                    └───────┬───────┘
                            |
             ┌──────────────┼──────────────┐
             |              |              |
             v              v              v
       ┌──────────┐   ┌──────────┐   ┌──────────┐
       │ Backend  │   │ Backend  │   │ Backend  │
       │ Server 1 │   │ Server 2 │   │ Server 3 │
       └────┬─────┘   └────┬─────┘   └────┬─────┘
            |              |              |
            └──────────────┼──────────────┘
                           |
                    ┌──────v──────┐
                    │    Redis    │
                    │ Pub/Sub     │
                    │ Rate Limit  │
                    │ Sessions    │
                    └──────┬──────┘
                           |
                    ┌──────v──────┐
                    │ PostgreSQL  │
                    │ Users       │
                    │ Documents   │
                    │ Members     │
                    │ Revisions   │
                    └─────────────┘
```

Each backend instance also exposes `/healthz` (liveness) and `/readyz` (readiness — checks
Postgres + Redis connectivity) so the load balancer can route around a degraded instance.
Without this, the horizontal-scaling story in §36 has no real health signal behind it.

## 7. Frontend Architecture

```text
src/
├── components/
├── pages/
├── layouts/
├── hooks/
├── services/
├── store/
├── websocket/
├── collaboration/
├── auth/
├── types/
├── utils/
└── App.tsx
```

Important pages:

```text
/login
/register
/dashboard
/editor/:documentId
/documents/:documentId/history
/settings
```

Use `.tsx` for components and `.ts` for non-component modules. Define shared domain types
(`User`, `Document`, `Role`, `Revision`) once in `types/` and reuse everywhere — avoid inline `any`.

## 8. Dashboard

Must contain: user information, create-document button, recent documents, owned documents,
shared documents, search, language filter, last-updated timestamp, document owner, user role.

Document list must be paginated (limit/offset or cursor-based) — never return every document a
user can see in one response. This is also a natural place to demonstrate database indexing
decisions in an interview.

Document card:

```text
┌─────────────────────────────┐
│ algorithm.java              │
│ Java                        │
│ Last edited 2 minutes ago   │
│ Role: Editor                │
└─────────────────────────────┘
```

## 9. Editor UI

Should resemble a modern IDE.

```text
┌───────────────────────────────────────────────┐
│ Logo   Document Name    Users   Share  Save  │
├────────┬──────────────────────────────────────┤
│ Files  │                                      │
│        │       Monaco Editor                  │
│ main   │                                      │
│ test   │                                      │
│ utils  │                                      │
├────────┴──────────────────────────────────────┤
│ 🟢 User A   🟢 User B       Connected         │
└───────────────────────────────────────────────┘
```

Features: syntax highlighting, line numbers, dark theme, language selection, save status,
connection status, active collaborators, share button, revision history, read-only mode for viewers.

## 10. Authentication

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout
GET  /api/auth/me
```

Registration takes `email`, `password`, `name`. Validate all of it with a Zod schema before it
ever reaches a controller — invalid input must never reach business logic.

```text
plaintext → secure hash → PostgreSQL
```

Never store plaintext passwords.

## 11. Token Architecture

Short-lived access token + long-lived refresh token.

Refresh token stored in an `HttpOnly`, `Secure`, `SameSite` cookie appropriate for the deployment.
Maintain server-side refresh-session information in Redis. Implement refresh-token rotation.
Logout must invalidate the refresh session. Do not store sensitive authentication tokens
unnecessarily in localStorage.

**WebSocket authentication specifically.** Browsers cannot set custom headers on a WebSocket
handshake, so the access token can't be attached the way it is on REST calls. Use one of:

- A short-lived, single-use connection ticket: the client calls an authenticated REST endpoint
  (`POST /api/documents/:id/ws-ticket`) right before opening the socket, receives a ticket, and
  passes it as a query parameter on the WS URL. The server validates and immediately invalidates
  the ticket.
- Alternatively, authenticate via the first message sent after the socket opens, closing the
  connection if auth fails within a short timeout.

Avoid putting the raw JWT in the WebSocket URL query string — it ends up in server access logs and
browser history. A single-use ticket avoids that.

## 12. Security

Implement: password hashing; JWT verification; refresh-token rotation; HttpOnly cookies; Secure
cookies in production; SameSite policy; CORS configuration; rate limiting (REST endpoints,
WebSocket connection attempts, and WebSocket message throughput — a connected client can still
flood updates); input validation (Zod on every external boundary); authorization middleware;
document ownership checks; WebSocket authorization; security headers; request size limits;
document size limits (cap Y.Doc size to prevent unbounded growth / DoS); environment variables for
secrets validated at startup with a Zod schema so the app fails fast with a clear error rather than
crashing later on `undefined`; no secrets committed to Git.

Protect against:

```text
Brute force
Unauthorized document access
Session abuse
CSRF
XSS
Privilege escalation
Malformed input
WebSocket abuse
```

Model roles as a TypeScript union (`type Role = 'OWNER' | 'EDITOR' | 'VIEWER'`) rather than a bare
string — this turns a typo'd role check into a compile error instead of a silent authorization bug.

**Do not claim security features that have not actually been implemented.**

## 13. Database Schema

**users**

```text
id
name
email          -- UNIQUE
password_hash
created_at
updated_at
```

**documents**

```text
id
owner_id
name
language
deleted_at   -- nullable; soft delete so revisions/history survive deletion
created_at
updated_at
```

**document_members**

```text
document_id
user_id
role          -- OWNER | EDITOR | VIEWER
created_at
```

Composite uniqueness: `(document_id, user_id)`.

**document_revisions**

```text
id
document_id
created_by
snapshot        -- binary: Y.encodeStateAsUpdate() output, NOT plain text
revision_number
created_at
```

Storing the raw Yjs binary update (not just the rendered text) is what makes restore correct — a
Y.Doc's true state includes CRDT metadata (tombstones, client IDs) that plain text throws away.
Restoring means loading this snapshot into a fresh `Y.Doc` and replaying it into the live document,
then writing a new revision — never deleting old ones.

If Prisma is used, generate the TS types for these tables directly from the schema rather than
hand-writing DTOs that can drift from the DB.

## 14. Relationships

```text
User --owns--> Document --has many--> DocumentMember --belongs to--> User
Document --has many--> DocumentRevision
```

Use foreign keys and indexes appropriately.

## 15. REST API

```text
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/documents            -- paginated, supports ?search, ?language, ?sort
POST   /api/documents
GET    /api/documents/:id
PATCH  /api/documents/:id
DELETE /api/documents/:id        -- soft delete

GET    /api/documents/:id/members
POST   /api/documents/:id/members
PATCH  /api/documents/:id/members/:userId
DELETE /api/documents/:id/members/:userId

GET  /api/documents/:id/revisions              -- paginated
GET  /api/documents/:id/revisions/:revisionId
POST /api/documents/:id/revisions/:revisionId/restore

POST /api/documents/:id/ws-ticket   -- issues a short-lived connection ticket
```

All endpoints must enforce authorization. Document the API with an OpenAPI/Swagger spec (can be
generated from Zod schemas via `zod-to-openapi`) — low effort, good portfolio signal.

## 16. Role Permissions

**OWNER** — read, write, invite, remove users, change roles, rename, delete, create revisions,
restore revisions.

**EDITOR** — read, write, create revisions. Cannot delete, manage members, or change ownership.

**VIEWER** — read only. Cannot edit, delete, invite, or restore.

Authorization must be enforced on the backend. Frontend restrictions alone are NOT sufficient.

## 17. WebSocket Architecture

```text
Browser --WebSocket (?ticket=...)--> Backend
```

When opening a document:

```text
connect with ticket
   ↓
validate + consume ticket
   ↓
authorize document access
   ↓
join document room
   ↓
synchronize document state
```

Conceptual room: `document:<documentId>`

Define every WebSocket message as a discriminated union in TypeScript:

```ts
type ClientMessage =
  | { type: 'sync'; documentId: string; update: Uint8Array }
  | { type: 'awareness'; documentId: string; update: Uint8Array };

type ServerMessage =
  | { type: 'sync'; update: Uint8Array }
  | { type: 'awareness'; update: Uint8Array }
  | { type: 'error'; code: string; message: string };
```

Validate incoming messages against a Zod schema mirroring this union before touching them — never
trust the shape of anything read off the socket.

## 18. Yjs / CRDT

Do NOT implement collaborative text synchronization by sending the entire document after every
keystroke. Use Yjs.

```text
Monaco Editor ↕ Y.Text ↕ Y.Doc ↕ WebSocket ↕ Other clients
```

The system must allow User A and User B to edit simultaneously without one user's entire document
overwriting the other's latest string.

Understand and document: CRDT; Y.Doc; Y.Text; updates (binary diffs via `Y.encodeStateAsUpdate` /
applied via `Y.applyUpdate`); awareness/presence (`y-protocols/awareness`); synchronization;
eventual convergence.

Note explicitly in `docs/collaboration.md` whether the WebSocket sync protocol is hand-rolled or
uses `y-websocket`'s existing client/server implementation — either is defensible, but be able to
explain the trade-off (learning value of building it vs. using a battle-tested implementation).

## 19. Collaboration Flow

```text
User A types → Monaco → Yjs → CRDT update (Uint8Array) → WebSocket → Backend
   → Redis Pub/Sub (base64-encoded, or binary-safe channel)
   → Other backend instances → Other clients → Yjs → Monaco
```

All connected clients should eventually converge to the same document state.

Decide and document the Redis wire format explicitly: base64-encode the `Uint8Array` update inside
a JSON envelope (simplest, slight overhead) vs. publishing raw binary on a binary-safe Redis client
(more efficient, more setup). For a portfolio project, base64-in-JSON is the pragmatic choice —
call that out as a deliberate simplicity trade-off rather than an oversight.

## 20. Presence

Awareness information: user name, user ID, online/offline, cursor position, selection where
practical.

```text
Active collaborators
🟢 Hargun
🟢 Rahul
🟢 Aman
```

Do not persist ephemeral presence information in PostgreSQL. Presence is transient state.

## 21. Reconnection

Handle Wi-Fi disconnect, server restart, browser network change, WebSocket failure.

```text
detect disconnect
      ↓
show "Reconnecting..."
      ↓
attempt reconnect (with backoff)
      ↓
request a fresh ticket + authenticate
      ↓
rejoin document
      ↓
synchronize state (exchange Yjs state vectors, not full document)
      ↓
show "Connected"
```

Do not silently lose unsynchronized edits — Yjs's local state should survive a reconnect and
re-sync via state-vector diffing once the socket is back.

## 22. Redis Architecture

Pub/Sub for cross-instance WebSocket communication:

```text
Server A --publish--> Redis channel --> Server B
                                   --> Server C
```

Use document-specific channels where appropriate, e.g. `document:<documentId>`.

## 23. Important Redis Principle

Redis Pub/Sub is NOT the source of truth for document persistence. If a message is missed, Redis
Pub/Sub does not replace PostgreSQL / durable document state. The system must have a
recovery/resynchronization mechanism. This distinction should be documented in the architecture.

## 24. Persistence Strategy

Do NOT write to PostgreSQL for every keystroke.

```text
User edit → Yjs state → Debounce → Persistence (Y.encodeStateAsUpdate → document_revisions.snapshot)
```

For example: no changes for a short period → save snapshot. Also create periodic revisions.

The exact debounce interval must be configurable through environment variables, validated at
startup (Zod: `z.coerce.number().positive()`).

## 25. Revision History

Authorized users should see `Revision 1 / 2 / 3 / Current`, each showing revision number, created
by, created at. Allow authorized users to restore a previous revision. Restoration must create a
new revision rather than destroying history.

Restore mechanics: load the target revision's binary snapshot into a fresh `Y.Doc`, then apply it
as an update to the live document (so concurrently-connected clients receive it as a normal CRDT
update, not a hard overwrite), then persist the result as a new revision.

```text
Revision 1
Revision 2
Revision 3
Revision 4 ← restored from Revision 2
```

## 26. Document Lifecycle

```text
Create → Open → Load persisted state → Join collaboration session → Edit → Broadcast
      → Persist → Create revision → Close
```

## 27. Error Handling

Frontend must clearly handle 401, 403, 404, 409, 422, 429, 500.

WebSocket errors should also be handled (use the typed `{ type: 'error'; code; message }` message
shape from §17 rather than closing the socket silently).

Never expose stack traces or internal database errors to users in production. Use structured
backend logging.

## 28. Rate Limiting

Redis-based rate limiting for `/login`, `/register`, `/refresh`. Also protect WebSocket connection
attempts and WebSocket message throughput per connection. Rate limits configurable via env vars,
validated at startup.

## 29. Logging

Structured logs including request ID, user ID where appropriate, route, HTTP status, latency, error
type, WebSocket connection events.

Do NOT log passwords, JWT secrets, refresh tokens, or private code unnecessarily.

## 30. Frontend State

Separate **server state** (documents, members, revisions, user profile) from **collaboration
state** (Y.Doc, Y.Text, presence, connection state).

Do not unnecessarily duplicate Yjs state into React state on every keystroke — let Monaco's Yjs
binding own the editor content, and only surface derived UI state (connection status, collaborator
list) into React.

## 31. Editor Language Support

Initially: JavaScript, TypeScript, Java, Python, C++, HTML, CSS, JSON. The language list should be
extensible.

Do NOT build code execution initially. This project is a collaborative editor, not an online
compiler. If code execution is added later, it must use sandboxed isolated execution rather than
executing arbitrary user code directly on the backend.

## 32. Search

Dashboard supports search by document name, filter by language, filter by owner, sort by updated
time. Implement database indexes where appropriate, and paginate all list results.

## 33. Docker

Create `Dockerfile.frontend`, `Dockerfile.backend`, `docker-compose.yml`.

Development environment: frontend, backend, PostgreSQL, Redis, Nginx.

Backend Dockerfile should run a multi-stage build: `tsc` compile stage, then a slim runtime stage
that only ships compiled JS + `node_modules` — don't ship `ts-node` or dev dependencies to
production.

A developer should be able to start the infrastructure with `docker compose up`. Do not hard-code
credentials; use environment variables.

## 34. Environment Configuration

Provide `.env.example`. Example categories:

```text
DATABASE_URL
REDIS_URL
JWT_SECRET
JWT_REFRESH_SECRET
CLIENT_URL
PORT
NODE_ENV
WS_TICKET_TTL_SECONDS
DOC_SNAPSHOT_DEBOUNCE_MS
MAX_DOCUMENT_SIZE_BYTES
```

Validate the full set with a single Zod schema at process startup — fail fast with a clear message
if anything's missing or malformed, rather than surfacing `undefined` deep in a request handler.
Never commit the real `.env`.

## 35. Nginx

Reverse proxy; load balancing; static frontend serving where appropriate; WebSocket upgrade
support; basic request controls; routing `/healthz` and `/readyz` checks appropriately (or
excluding them from access logs to reduce noise).

Ensure WebSocket upgrade headers are correctly configured.

## 36. Horizontal Scaling

The backend must support Backend 1 / 2 / 3 behind a load balancer. A client on Server 1 and a
client on Server 2 must still collaborate correctly. Redis Pub/Sub handles cross-instance update
propagation. Do not rely on in-memory state existing only on one server.

## 37. Multi-Instance Demo

Create a reproducible local test:

```text
             Nginx
            /     \
      Server 1   Server 2
         |           |
         └─────┬─────┘
             Redis
```

Open Browser A → Server 1 and Browser B → Server 2, edit the same document; both browsers must
receive updates. Demonstrate this in the README — ideally as a short screen-recording GIF, since
this feature is the entire point of the project and is far more convincing shown than described.

## 38. Testing Strategy

**Unit** — authentication, authorization, document service, revision service, validation (Zod
schemas).

**API integration** — register, login, create document, get document, invite member, change role,
delete document.

**Collaboration** — two clients, concurrent updates, reconnection, cross-instance synchronization.

**Security** — viewer cannot edit; non-member cannot access; invalid token rejected; expired token
rejected; rate limit works; oversized document rejected.

Use `ts-jest` or `vitest` (both have first-class TS support) rather than plain Jest with
`babel-jest` — fewer moving parts for a TS backend.

## 39. CI/CD

```text
git push → Install dependencies → Lint → Type check (tsc --noEmit)
        → Unit tests → Integration tests → Build → Docker build
```

Deployment can be added after CI is stable.

## 40. AWS Deployment

```text
Internet → AWS / Nginx → Load Balancer → EC2 #1 / EC2 #2 → Redis → PostgreSQL
```

Start simple. A single EC2 deployment is acceptable for the first deployment. Then demonstrate
multi-instance scaling — this is the highest-value phase to protect if time gets tight, since it's
the concrete proof of the horizontal-scaling story.

## 41. Database Reliability

Transactions for operations requiring atomicity; foreign keys; unique constraints; indexes;
connection pooling; migration system (Prisma Migrate, if using Prisma).

Do not treat Redis as a replacement for PostgreSQL.

## 42. Important Edge Cases

```text
Two users edit simultaneously
User loses connection during edit
Server crashes during collaboration
User reconnects
User loses authorization while connected
Document deleted while someone has it open
User is removed while connected
Duplicate WebSocket connection
Multiple browser tabs
Empty document
Very large document (enforce MAX_DOCUMENT_SIZE_BYTES)
Invalid document ID
Expired authentication
Redis unavailable
PostgreSQL unavailable
```

Gracefully degrade where possible.

## 43. Redis Failure

The system must not silently corrupt documents if Redis becomes unavailable.

```text
Redis unavailable → Detect failure → Show degraded connection state
   → Prevent unsafe synchronization if necessary → Recover when Redis returns
```

Document the exact consistency behavior in the README.

## 44. PostgreSQL Failure

If persistence fails, do not report successful persistence. Expose a clear save status:
`Saved` / `Saving...` / `Save failed` / `Offline`.

## 45. UI/UX Quality

The project should NOT look like a college CRUD project. Use clean typography, consistent spacing,
a professional dashboard, responsive layout, dark editor theme, loading states, empty states, error
states, toasts where appropriate, connection indicator, save indicator, accessible buttons/forms.

## 46. README

```text
1. Project overview
2. Demo GIF/screen recording (multi-user editing + multi-instance sync)
3. Features
4. Architecture diagram
5. Tech stack
6. Database schema
7. Authentication flow
8. WebSocket architecture (incl. ticket-based auth)
9. Yjs/CRDT explanation (incl. revision snapshot format decision)
10. Redis Pub/Sub architecture (incl. wire format decision)
11. Persistence strategy
12. Horizontal scaling
13. Local setup
14. Environment variables
15. Docker setup
16. Testing
17. Deployment
18. Security considerations
19. Known limitations
20. Future improvements
```

Include diagrams.

## 47. Architecture Documentation

```text
docs/
├── architecture.md
├── authentication.md
├── collaboration.md      <- include the snapshot-format and wire-format decisions here
├── database.md
├── scaling.md
├── security.md
└── deployment.md
```

The goal is to make the project easy to explain during interviews.

## 48. Development Phases

Do NOT implement everything simultaneously.

**Phase 1 — Foundation**

```text
[ ] Repository (with TS configs for frontend + backend, shared types workspace)
[ ] Frontend
[ ] Backend
[ ] PostgreSQL
[ ] Docker
[ ] Basic CI (lint + tsc --noEmit)
```

**Phase 2 — Authentication**

```text
[ ] Register
[ ] Login
[ ] JWT
[ ] Refresh token
[ ] Logout
[ ] Auth middleware
[ ] Zod validation on all auth payloads
```

**Phase 3 — Documents**

```text
[ ] Create
[ ] Read
[ ] Update
[ ] Delete (soft delete)
[ ] Dashboard (paginated)
```

**Phase 4 — Monaco**

```text
[ ] Editor
[ ] Syntax highlighting
[ ] Languages
[ ] Save/load
```

**Phase 5 — WebSockets**

```text
[ ] WebSocket server
[ ] Ticket-based authentication
[ ] Document rooms
[ ] Connection handling
[ ] Typed message envelopes (discriminated unions + Zod)
```

**Phase 6 — Yjs**

```text
[ ] Y.Doc
[ ] Y.Text
[ ] Monaco binding
[ ] Collaborative editing
[ ] Demo GIF for README (earliest point worth recording one)
```

**Phase 7 — Presence**

```text
[ ] Online users
[ ] Awareness
[ ] Cursor
[ ] Selection
```

**Phase 8 — Redis**

```text
[ ] Redis connection
[ ] Pub/Sub
[ ] Wire format decision (base64/JSON vs binary)
[ ] Cross-instance updates
```

**Phase 9 — Persistence**

```text
[ ] Binary snapshots (Y.encodeStateAsUpdate)
[ ] Debounced saving
[ ] Revision history
[ ] Restore (via fresh Y.Doc + applyUpdate)
```

**Phase 10 — Authorization**

```text
[ ] Owner
[ ] Editor
[ ] Viewer
[ ] Member management
[ ] WebSocket authorization
[ ] Role modeled as TS union type
```

**Phase 11 — Security**

```text
[ ] Rate limiting (REST + WS connection + WS message throughput)
[ ] Validation (Zod everywhere)
[ ] CORS
[ ] Security headers
[ ] CSRF strategy
[ ] WebSocket abuse protection
[ ] Document size limits
```

**Phase 12 — Production**

```text
[ ] Docker (multi-stage TS build)
[ ] Nginx
[ ] Multiple backend instances
[ ] Health checks (/healthz, /readyz)
[ ] Logging
[ ] Monitoring
[ ] Error handling
```

**Phase 13 — Testing**

```text
[ ] Unit (ts-jest / vitest)
[ ] Integration
[ ] WebSocket
[ ] Authorization
[ ] Concurrency
```

**Phase 14 — Deployment**

```text
[ ] AWS
[ ] HTTPS
[ ] Domain
[ ] CI/CD
[ ] Production environment
```

**Phase 15 — Final UI polish + documentation**

## 49. Definition of Done

**Authentication** — users can register/login/logout; passwords hashed; access tokens expire;
refresh sessions revocable.

**Editor** — Monaco works; documents persist; multiple languages work.

**Collaboration** — two users edit simultaneously; changes appear in real time; concurrent edits
converge; reconnection works without data loss; presence works.

**Scaling** — at least two backend instances run simultaneously; users on different instances
collaborate; Redis Pub/Sub synchronizes events; `/healthz` and `/readyz` work behind the LB.

**Persistence** — document state survives backend restart; revisions stored as binary Yjs
snapshots; revision restore creates a new revision without destroying history.

**Security** — unauthorized users cannot access documents; viewer cannot edit; WebSocket access
authorized via ticket; rate limiting works (REST and WebSocket); document size limits enforced;
secrets not committed.

**Deployment** — app runs through Docker; CI pipeline (including `tsc --noEmit`) passes; production
deployment works; HTTPS works; WebSocket connections work through the reverse proxy.

## 50. What NOT to Build Initially

```text
Online code execution
Video calling
Voice calling
AI code completion
Microservices
Kubernetes
Complex file systems
Mobile app
Native desktop app
```

These are distractions. First make collaborative editing excellent.

## 51. Future Extensions

Only after the core project is stable: AI coding assistant; code execution sandbox; integrated
terminal; project/file tree; Git integration; PR-style review; comments on lines; video/voice
collaboration; WebRTC; team workspaces; organization accounts; usage analytics. All optional.

## 52. Engineering Principles

1. TypeScript end-to-end, with shared types between frontend and backend where boundaries touch
   (WebSocket messages, DTOs, roles).
2. Keep frontend and backend clearly separated.
3. Keep business logic out of controllers.
4. Validate all external input with Zod, not just TypeScript types (types vanish at runtime).
5. Never trust frontend authorization.
6. Never store plaintext passwords.
7. Never commit secrets.
8. Don't use PostgreSQL for every keystroke.
9. Don't use Redis Pub/Sub as durable storage.
10. Don't synchronize the whole document on every keystroke.
11. Don't depend on a single backend instance's memory.
12. Handle WebSocket reconnects without losing local edits.
13. Write tests for important business logic.
14. Document architectural decisions — especially the ones with real trade-offs (snapshot format,
    wire format, hand-rolled vs. library sync).
15. Prefer simple architecture before adding complexity.

## 53. Expected Final Repository

```text
collaborative-code-editor/
│
├── frontend/
│   ├── src/
│   ├── Dockerfile
│   ├── tsconfig.json
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── services/
│   │   ├── repositories/
│   │   ├── middleware/
│   │   ├── websocket/
│   │   ├── auth/
│   │   ├── redis/
│   │   ├── database/
│   │   └── types/
│   ├── tests/
│   ├── Dockerfile
│   ├── tsconfig.json
│   └── package.json
│
├── shared/
│   └── types/            <- shared TS types (WS messages, roles, DTOs)
│
├── nginx/
│   └── nginx.conf
│
├── docs/
│   ├── architecture.md
│   ├── authentication.md
│   ├── collaboration.md
│   ├── database.md
│   ├── scaling.md
│   ├── security.md
│   └── deployment.md
│
├── .github/
│   └── workflows/
│
├── docker-compose.yml
├── .env.example
├── README.md
└── LICENSE
```

## 54. Working Rules

Implement this project incrementally. Before implementing each major phase:

1. Inspect the existing repository.
2. Understand the current architecture.
3. Make a small implementation plan.
4. Implement the phase.
5. Run tests.
6. Run type checking (`tsc --noEmit`).
7. Fix errors.
8. Update documentation.
9. Do not break previously working features.
10. Only then move to the next phase.

Do not rewrite the entire application when adding a feature. Do not introduce a new library unless
there is a clear reason. When choosing between a simple and complex implementation, prefer the
simpler implementation unless the complex one is necessary for the project's core goals.

## 55. Final Project Objective

The finished project should allow the developer to confidently explain the following in an SDE
interview:

**Frontend** — how Monaco works with React; how frontend state is organized; how WebSocket state
differs from normal API state; how TypeScript types are shared across the frontend/backend boundary.

**Backend** — REST API design; authentication (incl. WebSocket ticket-based auth); authorization;
service/repository architecture; error handling; why Zod alongside TypeScript (compile-time vs.
runtime safety).

**Distributed systems** — why WebSockets; why Redis Pub/Sub; why horizontal scaling; what happens
if a WebSocket server dies; what happens when Redis is unavailable; how reconnecting clients
synchronize.

**Concurrency** — what is a CRDT; why Yjs; why not simply replace the document string; how
concurrent edits converge; what happens during reconnection; why store binary snapshots instead of
plain text for revisions.

**Database** — PostgreSQL schema; relationships; indexes; transactions; persistence strategy;
revision history and restore mechanics.

**Security** — JWT; refresh tokens; HttpOnly cookies; CSRF; XSS; rate limiting; authorization.

**DevOps** — Docker (multi-stage TS builds); Nginx; CI/CD; AWS; horizontal scaling; health checks.

---

# Engineering Standards (agent instructions)

**Role.** Lead software engineer implementing this project. Read the whole spec before changing
code. The developer is a student preparing for software-engineering placements, so correctness,
architectural understanding, testability, clean code, and explainable design are more important
than raw implementation speed.

**Critical development rule.** DO NOT build the entire project in one pass. Implement strictly
phase-by-phase. For every phase:

1. Inspect the current repository.
2. Inspect existing implementation.
3. Identify what already works.
4. Produce a concise implementation plan.
5. Implement only that phase.
6. Run formatting/linting.
7. Run TypeScript checking.
8. Run relevant tests.
9. Fix all errors.
10. Update documentation.
11. Verify that earlier functionality still works.
12. Stop and report the completed phase.

Do not silently skip failing tests. Do not mark a feature complete if it is only partially
implemented.

**TypeScript.** Use strict TypeScript. Avoid `any`, unnecessary type assertions, duplicated domain
types, inline anonymous types for important domain objects. Use shared types for roles, WebSocket
message envelopes, document DTOs, API responses, collaboration events.

**Runtime validation.** Zod at every external trust boundary: REST request bodies, query
parameters where appropriate, WebSocket messages, environment variables, externally supplied
identifiers. TypeScript = compile-time guarantees; Zod = runtime validation. Use both.

**Do not** replace TypeScript with JavaScript. **Do not** add unnecessary frameworks or libraries.
Do not add microservices, Kubernetes, code execution, or AI features. Only add complexity when
required by the project's core architecture.

## Phase order (exact)

```text
Phase 1  Foundation
Phase 2  Authentication
Phase 3  Documents
Phase 4  Monaco
Phase 5  WebSockets
Phase 6  Yjs collaboration
Phase 7  Presence
Phase 8  Redis Pub/Sub
Phase 9  Persistence + revisions
Phase 10 RBAC
Phase 11 Security hardening
Phase 12 Docker + Nginx + health checks
Phase 13 Testing
Phase 14 AWS + horizontal scaling
Phase 15 Final UI polish + documentation
```

## Progress report format (end of every phase)

```text
Phase:
Completed:
Files changed:
Tests added:
Tests passing:
Type check:
Known issues:
Next phase:
```

Do not claim completion if tests or type-checking fail.

## Final verification scenarios

Before declaring the project complete, verify end-to-end:

1. Two users edit the same document simultaneously.
2. A user disconnects and reconnects without losing document state.
3. Two users connect to different backend instances and still collaborate.
4. A viewer attempts to edit and is rejected.
5. The backend restarts and persisted document state survives.
6. A previous revision is restored without deleting revision history.
7. Redis becomes unavailable and the system enters a documented degraded state rather than
   silently corrupting data.
8. The application passes linting, type checking, tests and production build.

Only after all of these work is the project portfolio-ready.
