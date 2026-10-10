# Testing

> **Implemented: Phase 13.** Five layers, from milliseconds to minutes. Each one
> exists because the layer below it cannot see a class of bug. Every result
> below was produced by the commands in this file.

## The layers

| Layer                 | Command                    | Count | Needs                     | In CI |
| --------------------- | -------------------------- | ----- | ------------------------- | ----- |
| Unit (shared)         | `npm test`                 | 57    | nothing                   | ✅    |
| Unit (backend)        | `npm test`                 | 169   | nothing                   | ✅    |
| Unit (frontend)       | `npm test`                 | 38    | nothing                   | ✅    |
| Integration (backend) | `npm run test:integration` | 32    | PostgreSQL + Redis        | ✅    |
| Stack smoke           | `npm run stack:smoke`      | 20    | the Docker stack          | ✅    |
| Browser end-to-end    | `npm run stack:e2e`        | 15    | the Docker stack + Chrome | ✅    |
| Scaling (Phase 14)    | `npm run stack:scale`      | 9     | the Docker stack          | ✅    |
| Resilience            | `npm run stack:resilience` | 21    | the Docker stack          | local |

```bash
npm test                                   # unit tests, all workspaces (seconds)
npm run infra:up && npm run test:integration   # real PostgreSQL + Redis (~35 s)
npm run test:coverage                      # unit + integration, with coverage
npm run stack:up                           # then, against the running stack:
npm run stack:smoke && npm run stack:e2e && npm run stack:scale && npm run stack:resilience
```

### 1. Unit tests (Vitest)

Fast, no infrastructure, run on every save. They test logic in isolation and
replace the edges (repositories, Redis, tickets) with fakes.

- **shared:** the permission matrix, message guards, base64 codec, presence
  validation.
- **backend:** Zod schemas, JWT and password handling, the error envelope,
  authorisation per role, rate limiting (memory store), revision rules, the
  collaboration hub — including two hubs over an in-memory bus that can simulate
  a Redis outage — driven through **real WebSocket servers** with real Yjs
  clients (`tests/helpers/yjs-test-client.js`).
- **frontend:** the WebSocket transport (`tests/ws-client.test.js`: tickets,
  "connected" means joined, message filtering, exponential backoff with a cap,
  which close codes are permanent) and the HTTP client (`tests/api.test.js`: the
  error envelope, Nginx's JSON 503, network failures). No browser: `WebSocket`,
  `window.location` and `fetch` are replaced and fake timers drive the backoff.

### 2. Integration tests (real PostgreSQL + Redis)

`backend/tests/integration/*.int.test.js`, configured by
`backend/vitest.integration.config.js`. **Nothing below the HTTP/WebSocket
boundary is mocked.** Each test starts real backend instances in-process (the
same pieces `server.js` wires together: app, hub, Redis Pub/Sub bus, Redis
rate-limit store, WebSocket server — `tests/integration/stack.js`), two of
them when the test is about several instances.

They exist because the unit tests' fakes cannot be wrong in the ways the real
systems can: a missing `FOR UPDATE`, a unique constraint that turns into a 500,
a `GET` where `GETDEL` was needed, a soft-delete filter forgotten in one query.

Safety: the suite uses its own database, `collab_editor_test` (created and
migrated with `prisma migrate deploy` by `global-setup.js`), and Redis database 15. It refuses to run against a database whose name does not end in `_test` or
against Redis database 0, because every test truncates all tables and empties
Redis. Files run one at a time.

| File                        | What it proves                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.int.test.js`          | bcrypt hash stored, email normalised, one account per email (also under a race), login, `/me`, refresh rotation and replay refusal (also across instances), logout, invalid/expired/foreign-secret tokens, per-email login limit shared by two instances                                                                                                       |
| `documents.int.test.js`     | create + OWNER membership in one transaction, listing (membership, order, pagination, search), 403/404 rules, owner-only rename/delete, soft delete, invite/role/remove, one-owner rules, concurrent invites, read-only member list                                                                                                                            |
| `collaboration.int.test.js` | tickets are single-use (also two racing handshakes, also across instances), concurrent typing on two instances converges and is stored, offline edits merge after reconnecting elsewhere, a full restart, a viewer's edit refused and never stored, live revocation across instances (4003/4004), the size cap, save + restore seen live on the other instance |
| `concurrency.int.test.js`   | partitioned instances saving at the same moment both survive (row lock + merge), six writers on two instances at random positions converge and are stored, racing "save version" creates exactly one revision, revision numbers stay gap-free                                                                                                                  |

### 3. Coverage

`npm run test:coverage` runs unit and integration tests in one Vitest run
(`backend/vitest.coverage.config.js`, two projects) and measures the backend
with V8. CI fails below 90 % statements / 85 % branches / 90 % functions /
90 % lines, and uploads the HTML report.

It runs in **worker threads**, configured per project (a root-level `pool`
setting does not reach Vitest projects). With the default child-process
workers, about one run in four died before starting with
`ERR_IPC_CHANNEL_CLOSED`. Two earlier attempts (one worker process; a
non-blocking migration step) did not fix it, which was only visible after
repeating the run many times; with threads, 17 consecutive runs passed. A few
runs right after the change exited with code 127 and no output and could not be
reproduced afterwards.

| Backend coverage   | Statements | Branches | Functions | Lines  |
| ------------------ | ---------- | -------- | --------- | ------ |
| Unit tests only    | 82.2 %     | 87.1 %   | 70.6 %    | 82.2 % |
| Unit + integration | 94.9 %     | 88.8 %   | 94.7 %    | 94.9 % |

The gap is the repositories, Redis code and wiring that unit tests replace with
fakes. What remains uncovered is mostly failure paths: the process exiting on
invalid configuration, readiness checks when a dependency is down, logging of
malformed tickets. `server.js` is excluded; it is exercised by the stack tests.

Coverage says which lines ran, not whether a test would notice them breaking.
That is what the mutation checks below are for.

### 4. Stack tests (Docker)

Against the production images, over HTTPS through Nginx only, like a browser
(`scripts/lib/target.mjs` picks the URL; a self-signed certificate is accepted
for localhost only):

- **`scripts/smoke-stack.mjs`** — the HTTP→HTTPS redirect, no HSTS on
  localhost, health routing, the static frontend and its
  headers, SPA fallback, asset caching, auth through the proxy, request-id
  correlation, four WebSocket clients converging across both instances.
- **`scripts/browser-e2e.mjs`** — two headless Chrome users through the **real
  UI**: sign up with the form, create a document from the dashboard, share it
  from the Share dialog, type into Monaco and see each other's text and
  presence, reload and stay signed in with the document intact; zero CSP
  violations, no failed requests, no console errors; served by different backend
  instances. Uses `playwright-core` with an installed Chrome (`CHROME_PATH`).
- **`scripts/scaling-stack.mjs`** (Phase 14) — `--scale backend=3`: Nginx routes
  to the new replica with no config change and nine clients spread 3/3/3, every
  edit reaches all of them; `--scale backend=2`: the removed replica shuts down
  gracefully, only its sockets close, they reconnect elsewhere, editing
  continues and Nginx stops routing to it.
- **`scripts/resilience-stack.mjs`** — `docker stop` (graceful shutdown keeps
  an unsaved edit), both backends down (JSON 503, app still served), one
  backend down (only its sockets move, editing and the API continue), the
  instance coming back, Redis down (readiness fails, liveness and Docker health
  do not), a request flood, log hygiene. Stops containers, so it runs locally.

## The spec's checklist (§38) and where each item is proven

| Spec item                                               | Proven by                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Unit: authentication                                    | `token.test.js`, `password.test.js`, `authenticate.test.js`, `auth.schemas.test.js`               |
| Unit: authorization                                     | `shared/tests/permissions.test.js`, `member.routes.test.js`, `collaboration.test.js`              |
| Unit: document service, revision service                | `revision.logic.test.js`, `revision.routes.test.js`; documents in `documents.int.test.js`         |
| Unit: validation (Zod)                                  | `auth.schemas.test.js`, `env.schema.test.js`, `collaboration.test.js` (WebSocket messages)        |
| API: register, login                                    | `auth.int.test.js`                                                                                |
| API: create / get document, invite, change role, delete | `documents.int.test.js`                                                                           |
| Collaboration: two clients, concurrent updates          | `collaboration.int.test.js`, `concurrency.int.test.js`, `collaboration.test.js`                   |
| Collaboration: reconnection                             | `collaboration.int.test.js` (offline edits, reconnect to the other instance), `ws-client.test.js` |
| Collaboration: cross-instance synchronisation           | `collaboration.int.test.js`, `cluster.test.js`, `smoke-stack.mjs`, `browser-e2e.mjs`              |
| Security: viewer cannot edit                            | `collaboration.int.test.js`, `collaboration.test.js`                                              |
| Security: non-member cannot access                      | `documents.int.test.js`, `member.routes.test.js`                                                  |
| Security: invalid / expired token rejected              | `auth.int.test.js`, `token.test.js`, `authenticate.test.js`                                       |
| Security: rate limit works                              | `auth.int.test.js` (Redis, two instances), `security.test.js`, `ws-security.test.js`              |
| Security: oversized document rejected                   | `collaboration.int.test.js`, `ws-security.test.js`                                                |
| Phase 13: WebSocket                                     | all of the above, plus `ws-shutdown.test.js`, `ws-client.test.js`                                 |
| Phase 13: concurrency                                   | `concurrency.int.test.js`, and the race tests in `auth.int.test.js` / `documents.int.test.js`     |

## Do the tests catch bugs? Mutation checks

A test that passes whatever the code does is worse than none. Throughout the
project, important tests were checked by **breaking the code on purpose** and
confirming the test fails. In Phase 13:

| Mutation (code deliberately broken)                         | Caught by                                     |
| ----------------------------------------------------------- | --------------------------------------------- |
| `FOR UPDATE` removed from the state lock                    | partitioned-instances merge test              |
| `deletedAt: null` removed from the list query               | soft-delete test                              |
| ticket consumed with `GET` instead of `GETDEL`              | single-use ticket tests                       |
| ticket consumed with `GET` then `DEL` (non-atomic)          | racing-handshakes test (5 of 5 runs)          |
| unique violation not handled on registration                | simultaneous-registration test                |
| refresh session read with `GET` instead of `GETDEL`         | refresh rotation test                         |
| `FORBIDDEN` dropped from the client's permanent close codes | `ws-client.test.js`                           |
| backoff reset when TCP opens instead of on `joined`         | `ws-client.test.js` (added after it survived) |
| `'unsafe-inline'` removed from the page's `style-src`       | `browser-e2e.mjs` (CSP violations, console)   |

One mutation survived at first (resetting the backoff on TCP open). A test was
added for it: a server that accepts the socket and then refuses it every time
must not be retried at the fastest rate forever.

## Bugs the tests found in Phase 13

- **Simultaneous registrations returned 500.** Both requests passed the "email
  taken?" check while bcrypt ran (~250 ms), then the unique index rejected the
  second insert, unhandled. Now a 409 (`user.repository.js`).
- **Ticket fallback broke single use.** On any `GETDEL` error the ticket was read
  with `GET` and then deleted: not atomic, so two racing handshakes could both
  get in. Removed; Redis 7 is pinned everywhere and errors now fail the
  handshake with a retryable close code.
- **A test helper could pass vacuously.** `eventually()` given an async check
  saw a Promise (always truthy) and passed without checking; three new tests
  used it that way, and two of them were passing vacuously. It now throws for async checks, and integration tests
  have `until()` for database reads.
- **Failover is not seamless at the request level.** In the first seconds after
  an instance stops, a request Nginx has already routed to it can fail once
  (503/504) instead of being retried elsewhere. Clients retry (the browser's
  backoff), so users see one reconnect; the resilience test now connects the way
  the browser does and reports the retries needed (1). Documented in
  [deployment.md](deployment.md#load-balancing).

## Writing a new test

- Logic with no I/O → a unit test next to the others.
- Anything that reads or writes PostgreSQL or Redis, or spans instances → an
  integration test using `startInstance`, `registerUser`, `openClient` from
  `tests/integration/stack.js`. Never mock what you are trying to prove.
- Waiting for something asynchronous: `eventually()` for in-memory state,
  `until()` for database reads. Never a bare `setTimeout` and hope.
- After writing it, break the code it protects and watch it fail.
