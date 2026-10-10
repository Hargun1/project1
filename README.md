# Real-Time Collaborative Code Editor

A multi-user code editor where several people type in the same file at the same
time and every keystroke converges without a lock, a merge dialog, or a lost
edit — VS Code Live Share's editing model with Google Docs' sharing model.

The interesting part is not the editor UI. It is the correctness problem
underneath it: concurrent edits are merged with a **CRDT** (Yjs) instead of a
server-side lock, edits are fanned out **across backend instances** with Redis
Pub/Sub so the system scales horizontally, and document state is persisted as
**binary Yjs snapshots** so a restored document keeps its merge history.

> **Status: Phase 13 of 15 (Testing) complete.** Accounts, documents,
> sharing with OWNER / EDITOR / VIEWER roles, the Monaco editor,
> ticket-authenticated WebSockets, real-time CRDT editing, live presence and
> revision history with restore work end to end, across **several backend
> instances** linked by Redis Pub/Sub, with rate limiting, document size caps,
> CSRF and WebSocket-origin checks. One command runs the whole system in Docker:
> Nginx serving the app and load-balancing two backend instances. About 330
> automated checks, from unit tests to two real browsers, run in CI
> ([docs/testing.md](docs/testing.md)). Cloud deployment is _not_ built yet. See
> [Build phases](#build-phases).

## Architecture

```
                    ┌──────────────────────────────────┐
   Browser ────────▶│  Nginx                           │
   React + Monaco   │  static assets · /api · /ws       │
                    └───────────────┬──────────────────┘
                                    │
                    ┌───────────────┴──────────────────┐
                    │                                  │
            ┌───────▼────────┐               ┌─────────▼──────┐
            │ Backend #1     │               │ Backend #2     │
            │ Express + ws   │               │ Express + ws   │
            │ Y.Doc in RAM   │               │ Y.Doc in RAM   │
            └───┬────────┬───┘               └───┬────────┬───┘
                │        │                       │        │
                │        └───────────┬───────────┘        │
                │                    │                    │
                │          ┌─────────▼─────────┐          │
                │          │ Redis Pub/Sub     │          │
                │          │ transport only —  │          │
                │          │ never durable     │          │
                │          └───────────────────┘          │
                │                                         │
                └──────────────┬──────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │ PostgreSQL          │
                    │ users · documents   │
                    │ members · revisions │
                    │ (Yjs snapshots)     │
                    └─────────────────────┘
```

Two rules explain most of the design:

- **Redis is a message bus, never a database.** If Redis is flushed, no document
  content is lost — durable state lives in PostgreSQL.
- **PostgreSQL stores CRDT state, not text.** A revision is
  `Y.encodeStateAsUpdate()` output in a `BYTEA` column. Storing rendered text
  would throw away the tombstones and client IDs that make a later merge
  converge correctly.

Longer write-ups: [docs/architecture.md](docs/architecture.md),
[docs/database.md](docs/database.md), and the full brief in
[docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md).

## Tech stack

| Layer    | Choices                                                                          |
| -------- | -------------------------------------------------------------------------------- |
| Frontend | React 19, JavaScript (ESM), Vite, Monaco Editor, Yjs, React Router, Tailwind CSS |
| Backend  | Node.js, JavaScript (ESM), Express 5, `ws`, Prisma, Zod, pino, JWT               |
| Data     | PostgreSQL 17 (durable), Redis 7 (Pub/Sub, tickets, rate limits)                 |
| Shared   | `@collab/shared` — roles, API envelopes and their runtime guards                 |
| Ops      | Docker Compose, Nginx, GitHub Actions, AWS (Phase 14)                            |

The whole repository is plain JavaScript with ES modules — no TypeScript, no
build step for `shared/` or `backend/`. Node runs the source directly; only the
frontend is bundled, by Vite.

`shared/` exists so a role string or an error code cannot drift between client
and server. Without a compiler to catch drift at build time, it ships **runtime
guards** (`isRole`, `isApiErrorCode`, `isApiErrorResponse`, `isDependencyState`)
and both sides call them at the trust boundary. Those guards are covered by 35
tests, because they are now the only thing enforcing the contract.

## Validation strategy

There is no `tsc --noEmit` gate, so correctness is enforced at runtime and in
tests instead:

| Boundary                                 | Enforced by                                                  |
| ---------------------------------------- | ------------------------------------------------------------ |
| Environment variables                    | Zod schema, parsed at startup — process exits on a bad value |
| Inbound HTTP request bodies              | Zod schemas per route (from Phase 2)                         |
| Roles and error codes                    | `@collab/shared` guards, called at every boundary            |
| Error envelopes on the wire              | `isApiErrorResponse` before the client trusts a body         |
| Undefined variables, bad imports, syntax | ESLint, which parses every file in CI                        |

`AppError` validates its own `code` against the shared list and throws a
`TypeError` on an unknown one, because a typo there would silently produce an
envelope the client rejects.

## Run the whole stack in Docker

The production images, two backend instances behind Nginx, PostgreSQL, Redis
and a migration job, on one command:

```bash
cp .env.example .env
# Production mode refuses the placeholder secrets. Set two different values:
#   JWT_SECRET=<openssl rand -hex 32>
#   JWT_REFRESH_SECRET=<openssl rand -hex 32>
npm install            # only needed for the smoke test
npm run stack:up       # build, start, wait until every container is healthy
npm run stack:smoke    # 18 checks through Nginx, including cross-instance editing
```

Open <http://localhost:8080> in two browsers (or one normal and one private
window), sign up as two users, share a document and type in both: Nginx's
`least_conn` balancing puts the two sockets on different backend instances, and
`npm run stack:logs` shows which instance served which user. Stop one instance
with `docker compose stop backend-1` and keep typing: its users reconnect to the
other instance. Details, failure tests and troubleshooting:
[docs/deployment.md](docs/deployment.md).

## Requirements

- Node.js **≥ 20.19** (developed on 24.x)
- Docker Desktop (for PostgreSQL and Redis)

## Getting started

```bash
git clone <repository-url>
cd project-1
npm install
cp .env.example .env
```

Start the infrastructure containers, then apply the schema:

```bash
npm run infra:up
```

```bash
npm run db:migrate
```

`infra:up` needs Docker Desktop already running with its Linux engine
available. On Windows, if it reports
`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`,
open Docker Desktop and wait for the whale icon to stop animating, then retry.

Run the backend and the frontend in two terminals:

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Open <http://localhost:5173>. The status page performs live `GET /healthz` and
`GET /readyz` calls through the typed API layer, so a green PostgreSQL card is
real evidence that browser → Vite proxy → Express → Prisma → Postgres works end
to end. Without the containers running, the page renders correctly and honestly
reports PostgreSQL as `down` — which is itself the readiness path working.

There is one `.env` at the repository root. Docker Compose reads it directly,
the backend loads it with dotenv, and Vite reads it via `envDir` — so a port or
password is defined in exactly one place. The backend validates every variable
with Zod at startup and exits with a readable list of problems rather than
failing later with `undefined`.

The security limits are variables too, with safe defaults: `RATE_LIMIT_*`,
`WS_MESSAGES_PER_SECOND`, `WS_MESSAGE_BURST`, `MAX_DOCUMENT_SIZE_BYTES` and
`TRUST_PROXY_HOPS` (how many reverse proxies' `X-Forwarded-For` entries to
trust). `.env.example` lists them all with comments.

## Scripts

| Command                    | What it does                                         |
| -------------------------- | ---------------------------------------------------- |
| `npm run dev:backend`      | Express with `node --watch` (no transpiler)          |
| `npm run dev:frontend`     | Vite dev server on :5173, proxying the API to :4000  |
| `npm run build`            | Bundles the frontend (nothing else needs building)   |
| `npm run lint`             | ESLint 9 flat config over the whole monorepo         |
| `npm test`                 | Unit tests (Vitest) in every workspace               |
| `npm run test:integration` | Backend against real PostgreSQL + Redis (`infra:up`) |
| `npm run test:coverage`    | Unit + integration with coverage thresholds          |
| `npm run db:migrate`       | Creates/applies a development migration              |
| `npm run db:studio`        | Prisma Studio                                        |
| `npm run infra:up`         | `docker compose up -d` (PostgreSQL + Redis)          |
| `npm run infra:down`       | Stops the containers, keeps the volume               |
| `npm run infra:reset`      | Stops the containers **and deletes the data volume** |
| `npm run stack:up`         | Whole system in Docker on :8080, waits until healthy |
| `npm run stack:smoke`      | Smoke test of the running stack through Nginx        |
| `npm run stack:e2e`        | Two headless Chrome users through the real UI        |
| `npm run stack:resilience` | Stops containers and Redis; checks recovery          |
| `npm run stack:logs`       | Follows every container's logs                       |
| `npm run stack:down`       | Stops the stack, keeps the data volume               |

## When Redis is unavailable

Redis carries live edits between backend instances; it never stores documents.
If it goes down mid-session (verified by stopping the container):

- Editing continues. Users on the same instance still see each other live;
  users on different instances stop seeing each other, and the editor shows
  **Degraded: other servers out of sync**.
- Saving continues. Each save merges into PostgreSQL under a row lock, so the
  instances' diverged copies are combined, never overwritten.
- New connections and logins fail (tickets and refresh sessions live in Redis)
  and `/readyz` reports `503`, so a load balancer stops routing new traffic.
- When Redis returns, the instances re-run a state-vector handshake and every
  edit made during the outage appears everywhere, without clients reconnecting.

Full behaviour table: [docs/scaling.md](docs/scaling.md#when-redis-is-unavailable-43).

## Health endpoints

| Endpoint   | Meaning                                                                    |
| ---------- | -------------------------------------------------------------------------- |
| `/healthz` | Liveness. Touches no dependency; answers `200` whenever the process is up. |
| `/readyz`  | Readiness. Round-trips PostgreSQL; answers `503 degraded` when it is down. |

The split matters for orchestration: a liveness probe that queried the database
would make a load balancer kill and restart healthy application containers
during a database blip.

## Repository layout

```
shared/                 Contracts shared across the trust boundary
  src/roles.js          ROLES + isRole guard (OWNER | EDITOR | VIEWER)
  src/permissions.js    the permission matrix + can(role, action), used by both sides
  src/api.js            Error codes, envelope guards
  src/ws-messages.js    WebSocket message vocabulary, close/error codes
  src/encoding.js       base64 <-> Uint8Array for Yjs payloads in JSON
  src/health.js         Dependency states + documented health/readiness shapes
  tests/                Guards and codec tests

backend/
  prisma/schema.prisma  users · documents · document_members · document_revisions
  src/config/           Zod-validated environment, constants
  src/middleware/       request-id, JWT authentication, central error handler
  src/routes/ controllers/ services/ repositories/
                        REST layers: auth, documents, health
  src/services/collaboration.service.js, presence.service.js
                        Hub: one Y.Doc + Awareness per open document, synced
                        across instances over Redis; merge-on-save; debounced
                        saves; validated, identity-checked presence
  src/websocket/        ws server, tickets, connection lifecycle, Zod schemas
  src/auth/             bcrypt, JWT, rotating refresh sessions in Redis
  src/database/ redis/  Prisma client, ioredis client, Pub/Sub bus + envelope schema
  src/utils/            pino logger (with redaction), AppError
  src/app.js            createApp() — no listener, so tests can import it
  src/server.js         listen + WebSocket attach + graceful shutdown/flush
  tests/                Vitest + supertest; collaboration and cluster tests drive
                        real WebSocket servers (two instances over an in-memory
                        bus that can simulate a Redis outage) with real Yjs clients
  tests/integration/    The same against real PostgreSQL + Redis: auth, documents,
                        collaboration across instances, concurrency

frontend/
  src/auth/             AuthProvider (in-memory access token, silent refresh)
  src/services/         fetch layer, ApiError, REST clients
  src/websocket/        Socket transport: tickets, keepalive, backoff
  src/collaboration/    Yjs sync protocol, save status, escaped cursor CSS
  src/hooks/            usePresence (who is here, without per-cursor renders)
  tests/                Vitest: WebSocket transport, HTTP client, pure modules
  src/pages/            Status, login, register, dashboard, editor, history
  src/utils/            Language list, Monaco worker/bundling setup

scripts/                Stack smoke, browser end-to-end and resilience tests
docs/                   Architecture, database, testing, and per-phase deep dives
```

## Security posture

Implemented in Phase 1:

- Helmet security headers; `x-powered-by` disabled
- CORS restricted to `CLIENT_URL` with credentials enabled
- 100 kB JSON body limit, returning a typed `PAYLOAD_TOO_LARGE` error
- Zod validation of environment variables at boot, refusing placeholder secrets
  in production
- Structured logging with `authorization`, `cookie`, `password`, `token`,
  `refreshToken` and `ticket` **removed** from log output
- A central error handler that returns a typed envelope and never leaks stack
  traces or database errors in production

Implemented in Phases 2–6: bcrypt password hashing; short-lived JWT access
tokens with an atomically rotated `HttpOnly` refresh cookie; single-use
WebSocket tickets; role re-checked on every socket connection, with edits from
viewers refused on the server; Zod validation of every WebSocket message.
Details and test references: [docs/security.md](docs/security.md).

Implemented in Phase 10: one permission matrix shared by server and UI,
member management (invite, change role, remove, leave), and live revocation of
open connections across instances.

Implemented in Phase 11: rate limits shared across instances through Redis
(auth per IP and per email, API per user, WebSocket connections per IP,
messages per socket), the document size cap, an Origin check for CSRF and for
WebSocket upgrades, a fix for a login timing leak, bcrypt's 72-byte limit, and
`Cache-Control: no-store` on the API. Details: [docs/security.md](docs/security.md).

Implemented in Phase 12: a strict Content-Security-Policy and security headers on
the page, served by Nginx (no inline scripts, no third-party origins), coarse
per-IP flood limits in Nginx in front of the backend's precise ones, and a
`draining` readiness state during graceful shutdown.

Planned, and deliberately not claimed as working yet: HTTPS and HSTS, which
belong to the cloud deployment (Phase 14).

## Build phases

| #   | Phase                   | Status  |
| --- | ----------------------- | ------- |
| 1   | Foundation              | ✅ done |
| 2   | Authentication          | ✅ done |
| 3   | Documents               | ✅ done |
| 4   | Monaco editor           | ✅ done |
| 5   | WebSockets              | ✅ done |
| 6   | Yjs collaboration       | ✅ done |
| 7   | Presence + awareness    | ✅ done |
| 8   | Redis Pub/Sub scaling   | ✅ done |
| 9   | Persistence + revisions | ✅ done |
| 10  | Role-based access       | ✅ done |
| 11  | Security hardening      | ✅ done |
| 12  | Docker + Nginx          | ✅ done |
| 13  | Testing                 | ✅ done |
| 14  | AWS + scaling proof     | —       |
| 15  | Polish + documentation  | —       |

## License

MIT — see [LICENSE](LICENSE).
