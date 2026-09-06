# Real-Time Collaborative Code Editor

A multi-user code editor where several people type in the same file at the same
time and every keystroke converges without a lock, a merge dialog, or a lost
edit — VS Code Live Share's editing model with Google Docs' sharing model.

The interesting part is not the editor UI. It is the correctness problem
underneath it: concurrent edits are merged with a **CRDT** (Yjs) instead of a
server-side lock, edits are fanned out **across backend instances** with Redis
Pub/Sub so the system scales horizontally, and document state is persisted as
**binary Yjs snapshots** so a restored document keeps its merge history.

> **Status: Phase 1 of 15 (Foundation) complete.** The monorepo, shared type
> package, Express server, database schema, React client and CI pipeline are in
> place and verified. Authentication, documents, the Monaco editor, WebSockets
> and Yjs collaboration are _not_ implemented yet — the routes exist and say so.
> See [Build phases](#build-phases).

## Architecture

```
                    ┌──────────────────────────────────┐
   Browser ────────▶│  Nginx (Phase 12)                │
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

| Layer    | Choices                                                                    |
| -------- | -------------------------------------------------------------------------- |
| Frontend | React 19, TypeScript, Vite, Monaco Editor, Yjs, React Router, Tailwind CSS |
| Backend  | Node.js, TypeScript, Express 5, `ws`, Prisma, Zod, pino, JWT               |
| Data     | PostgreSQL 17 (durable), Redis 7 (Pub/Sub, tickets, rate limits)           |
| Shared   | `@collab/shared` — one definition of roles, API envelopes and DTOs         |
| Ops      | Docker Compose, Nginx, GitHub Actions, AWS (Phase 14)                      |

`shared/` exists so a role string or an error code cannot drift between client
and server: both import the same type, and a mismatch is a compile error rather
than a production bug.

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

## Scripts

| Command                | What it does                                         |
| ---------------------- | ---------------------------------------------------- |
| `npm run dev:backend`  | Express with `tsx watch`                             |
| `npm run dev:frontend` | Vite dev server on :5173, proxying the API to :4000  |
| `npm run build`        | Builds `shared` → `backend` → `frontend`             |
| `npm run typecheck`    | `tsc --noEmit` across every workspace                |
| `npm run lint`         | ESLint 9 flat config over the whole monorepo         |
| `npm test`             | Vitest in each workspace that has tests              |
| `npm run db:migrate`   | Creates/applies a development migration              |
| `npm run db:studio`    | Prisma Studio                                        |
| `npm run infra:up`     | `docker compose up -d` (PostgreSQL + Redis)          |
| `npm run infra:down`   | Stops the containers, keeps the volume               |
| `npm run infra:reset`  | Stops the containers **and deletes the data volume** |

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
shared/                 Types shared across the trust boundary
  src/roles.ts          Role union + guard (OWNER | EDITOR | VIEWER)
  src/api.ts            Error codes and the API error envelope
  src/health.ts         Health / readiness DTOs

backend/
  prisma/schema.prisma  users · documents · document_members · document_revisions
  src/config/           Zod-validated environment, constants
  src/middleware/       request-id, central error handler
  src/routes/           health routes
  src/database/         Prisma client + connection check
  src/utils/            pino logger (with redaction), AppError
  src/app.ts            createApp() — no listener, so tests can import it
  src/server.ts         listen + graceful shutdown
  tests/                Vitest + supertest

frontend/
  src/services/         Typed fetch layer, ApiError
  src/components/       Presentational pieces
  src/layouts/          App shell
  src/pages/            Status page (real) + phase-labelled placeholders

docs/                   Architecture, database, and per-phase deep dives
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

Planned, and deliberately not claimed as working yet: password hashing, JWT
access/refresh tokens, single-use WebSocket tickets, rate limiting, and RBAC
enforced server-side (Phases 2, 8, 10 and 11).

## Build phases

| #   | Phase                   | Status  |
| --- | ----------------------- | ------- |
| 1   | Foundation              | ✅ done |
| 2   | Authentication          | —       |
| 3   | Documents               | —       |
| 4   | Monaco editor           | —       |
| 5   | WebSockets              | —       |
| 6   | Yjs collaboration       | —       |
| 7   | Presence + awareness    | —       |
| 8   | Redis Pub/Sub scaling   | —       |
| 9   | Persistence + revisions | —       |
| 10  | Role-based access       | —       |
| 11  | Security hardening      | —       |
| 12  | Docker + Nginx          | —       |
| 13  | Testing                 | —       |
| 14  | AWS + scaling proof     | —       |
| 15  | Polish + documentation  | —       |

## License

MIT — see [LICENSE](LICENSE).
