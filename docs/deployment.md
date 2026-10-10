# Deployment

> **Implemented: Phase 12 (Docker images, Nginx, health checks).** The whole
> system runs from one `docker compose` command: Nginx in front of two backend
> instances, PostgreSQL, Redis and a migration job. Cloud deployment (AWS, HTTPS)
> is Phase 14.

## Two ways to run

| Mode                   | Command                                                 | What runs where                                                                                    |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Development            | `npm run infra:up`, then `dev:backend` + `dev:frontend` | PostgreSQL + Redis in Docker; the app on the host with hot reload, Vite on :5173                   |
| Full stack (prod-like) | `npm run stack:up`                                      | Everything in Docker, production images, `NODE_ENV=production`, the app on <http://localhost:8080> |

The stack uses the services of the `app` [Compose profile](https://docs.docker.com/compose/how-tos/profiles/),
so plain `docker compose up` still starts only the infrastructure.

```bash
cp .env.example .env
# The stack runs in production mode, which refuses the placeholder secrets:
#   JWT_SECRET=<openssl rand -hex 32>
#   JWT_REFRESH_SECRET=<openssl rand -hex 32>   (must differ)
npm run stack:up       # build images, start everything, wait until healthy
npm run stack:smoke    # 18 checks through Nginx (see below)
npm run stack:logs     # follow every container's logs
npm run stack:down     # stop (the database volume is kept)
```

## Topology

```
            browser ──► nginx :8080 ─┬─► backend-1 :4000 ─┐
  (static files served by nginx)     └─► backend-2 :4000 ─┼─► redis   (Pub/Sub, sessions, tickets, rate limits)
                                                           └─► postgres (users, documents, revisions)
                         migrate (one-shot) ─────────────────► postgres
```

Only Nginx publishes a port. The backends are reachable only on the Compose
network, so every request passes through the proxy's limits and headers.

Start-up order is enforced with health conditions, not sleeps:

1. `postgres` and `redis` become **healthy** (`pg_isready`, `redis-cli ping`).
2. `migrate` runs `prisma migrate deploy` and must **exit 0**.
3. `backend-1` and `backend-2` start and become **healthy** (`/healthz`).
4. `nginx` starts.

Running migrations in a separate one-shot service means two instances never race
to migrate the same database, and no instance ever serves traffic against an old
schema. `prisma migrate dev` (which can reset data) is never run against a
deployed database.

## Images

### Backend: `backend/Dockerfile`

Built from the repository root (the backend imports the `shared` workspace).

| Stage       | Contents                                                                     | Used for               |
| ----------- | ---------------------------------------------------------------------------- | ---------------------- |
| `base`      | `node:24-bookworm-slim` + OpenSSL (Prisma's engine needs it)                 | everything below       |
| `build`     | all dependencies incl. dev, generated Prisma client, source                  | the `migrate` service  |
| `prod-deps` | `npm ci --omit=dev --omit=optional` for the backend workspace only           | copied into `runtime`  |
| `runtime`   | prod `node_modules` + generated Prisma client + `shared/src` + `backend/src` | the backend containers |

- There is no compile step (plain JavaScript); the stages exist to keep dev
  tools out of production. The runtime image contains no Prisma CLI, test
  runner, linter or frontend packages.
- `--omit=optional` matters: the Prisma CLI is a dev dependency but also an
  optional peer of `@prisma/client`, which npm marks "devOptional" and keeps
  unless both kinds are omitted. That alone was ~110 MB; the image went from
  691 MB to 513 MB, of which the Node base image is most.
- Debian slim rather than Alpine: Prisma's engines and bcrypt ship prebuilt glibc
  binaries, so nothing is compiled and nothing needs musl workarounds.
- Runs as the unprivileged `node` user; code and dependencies are owned by root,
  so the process cannot modify itself.
- `CMD ["node", "src/server.js"]` in exec form, and Compose runs it under `init`
  (tini). `docker stop` sends SIGTERM straight to Node, which runs the graceful
  shutdown: report `draining` on `/readyz`, close sockets with `4008`, persist
  every open document, close HTTP, disconnect PostgreSQL and Redis. Compose
  allows 15 s (`stop_grace_period`); the server gives itself 10 s. Clients get
  2 s to answer the close frame, then their sockets are terminated: a client that
  never answers used to hold shutdown for `ws`'s 30 s close timeout, so the
  10 s force-exit fired before documents were flushed (found by these tests,
  regression test `ws-shutdown.test.js`). Measured now: about 2 s from SIGTERM
  to exit, with sockets still open.
- Layer order: manifests and `npm ci` first, source last, so a code change does
  not reinstall dependencies.

### Web: `frontend/Dockerfile`

Stage 1 builds the React app with Vite (Node and all build tools). Stage 2 is
`nginx:1.28-alpine` with the built files and the Nginx config: no Node, no
`node_modules`, no source. 160 MB, most of it the Nginx base image.

`.dockerignore` keeps `node_modules`, build output, `.git` and **`.env`** out of
the build context, so secrets can never be baked into an image. Containers get
configuration from the environment at run time.

## Configuration

One `.env` at the repository root, as in development. The backends read it
through `env_file`, and Compose then overrides what must differ inside the
container network:

| Variable           | In the stack                                        | Why                                                        |
| ------------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| `NODE_ENV`         | `production`                                        | Secure cookies, JSON logs, real-secret check               |
| `DATABASE_URL`     | built from `POSTGRES_*`, host `postgres`            | `localhost` inside a container is the container itself     |
| `REDIS_URL`        | `redis://redis:6379`                                | same                                                       |
| `CLIENT_URL`       | `STACK_CLIENT_URL`, default `http://localhost:8080` | CORS, the CSRF Origin check and the WebSocket Origin check |
| `TRUST_PROXY_HOPS` | `1`                                                 | exactly one proxy (Nginx) in front                         |
| `LOG_LEVEL`        | `STACK_LOG_LEVEL`, default `info`                   |                                                            |

`STACK_HTTP_PORT` (default 8080) changes the published port. If you change it,
set `STACK_CLIENT_URL` to match, or the Origin checks will refuse the browser.

Both `docker compose` and the backend validate configuration: the backend's
Zod schema refuses to start with placeholder secrets in production and names the
offending variable in the container log.

## Nginx

All of it is in [`nginx/nginx.conf`](../nginx/nginx.conf), with two included
snippets ([`proxy-headers.conf`](../nginx/proxy-headers.conf),
[`security-headers.conf`](../nginx/security-headers.conf)).

| Path                  | Behaviour                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `/`                   | `index.html` for every client-side route (SPA fallback), `Cache-Control: no-cache`                |
| `/assets/`            | hashed bundles, cached for a year (`expires 1y`)                                                  |
| `/api/`               | proxied to the backends, 30 req/s per IP (burst 60), JSON 429/503 for errors Nginx itself makes   |
| `/ws`                 | WebSocket upgrade, 50 concurrent sockets per IP, 120 s read timeout (the server pings every 30 s) |
| `/healthz`, `/readyz` | proxied to a backend, **not** access-logged                                                       |
| `/nginx-health`       | Nginx's own liveness, for its container healthcheck                                               |

### Load balancing

- **`least_conn`**, not round-robin: WebSockets live for hours, so "fewest open
  connections" spreads real load better than "next in line".
- **Passive health checks** (open-source Nginx has no active probing): after 3
  failed attempts an instance is skipped for 10 s. Requests that failed before
  reaching an instance are retried on the other one; POST/PATCH/DELETE are never
  retried once sent (Nginx's default), so nothing is applied twice.
- **`proxy_connect_timeout 3s`**: a stopped container's IP answers nothing, not
  even a refusal. With Nginx's 60 s default, WebSocket reconnects after a
  failover took a full minute. Found by the failover test (below).
- **Dynamic DNS** (`resolver 127.0.0.11 valid=5s` + `server … resolve`, Nginx
  ≥ 1.27.3): a stopped container leaves DNS and therefore the upstream; a
  restarted one is found again (measured: under 2 s, even with swapped IPs) and
  Nginx starts even if a backend is not up yet. Immediately after a restart there
  can be a few seconds in which Nginx routes to fewer instances than are running.

### Headers and limits

- `X-Forwarded-For` uses `$proxy_add_x_forwarded_for` (append), and the backend
  trusts exactly one hop, so a client-supplied `X-Forwarded-For` cannot change
  its rate-limit identity.
- `X-Request-Id` is always Nginx's own `$request_id`; the backend reuses it, so
  the Nginx line and the backend line for one request share an id.
- The page gets a strict Content-Security-Policy and the usual security headers
  (details in [security.md](security.md)). API responses keep helmet's headers
  from the backend.
- `server_tokens off`: no Nginx version in headers or error pages.
- `client_max_body_size 1m`; the backend's own 100 KB JSON limit answers first
  with its JSON 413.

## Health checks

| Probe           | Answers                                                                              | Who uses it                                                       |
| --------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `/healthz`      | "is the process alive?" — touches nothing                                            | Docker `HEALTHCHECK` of the backend image, Compose start order    |
| `/readyz`       | "can it serve traffic?" — PostgreSQL + Redis round trips; `draining` during shutdown | load balancers (the ALB in Phase 14), monitoring, the status page |
| `/nginx-health` | Nginx is up                                                                          | the web image's `HEALTHCHECK`                                     |

The container healthcheck deliberately uses liveness, not readiness: when Redis
went down in the test below, `/readyz` correctly answered 503 while Docker kept
both backends `healthy`, because restarting a process cannot fix Redis.
Restarting on readiness failures turns a dependency outage into a restart loop.

`draining` closes a gap in graceful shutdown: from the first moment of
shutdown, `/readyz` answers 503 so a load balancer that polls readiness stops
sending new work, while in-flight work finishes.

## Logs

Every container logs to stdout/stderr (`docker compose logs`), one JSON object
per line:

- **Nginx:** time, request id, client address, method, path **without the query
  string** (the WebSocket ticket is in it), status, bytes, timings and **which
  upstream served it**. Health probes are not logged.
- **Backend:** pino JSON. One compact line per request — id, method, url,
  client IP (resolved through the proxy), user id, status, response time — and
  no headers (the defaults logged every header, kilobytes per line). Socket
  events carry the instance id (`backend-1:4000`).

Nginx's _error_ log prints the request line of a failed upstream attempt,
query string included, so a failed `/ws` attempt can show a ticket. Tickets are
single-use and expire in 30 s, and a retry on another instance consumes it.

## Verified

`npm run stack:smoke` (also in CI): Nginx liveness; `/healthz` and `/readyz`
proxied; the built frontend at `/` with CSP and security headers, no Nginx
version, `no-cache`; SPA fallback for deep links; hashed assets cached a year;
registration through the proxy with a `Secure`, `HttpOnly`, `Path=/api/auth`
cookie; the backend reusing Nginx's request id; `no-store` on the API; JSON
error envelope through the proxy; four WebSocket clients spread over both
instances, an edit reaching all of them, a late joiner receiving the document.

Failure scenarios on the running stack (21 checks, 3 consecutive passing runs):

- `docker stop` → SIGTERM reaches Node, sockets close with 4008, and an edit
  made 300 ms earlier (inside the 2 s save debounce) is still there after
  restart. Every shutdown logs `WebSocket server closed`; none hits the
  force-exit.
- Both backends down → the API answers JSON `503 SERVICE_UNAVAILABLE` with
  `Retry-After`; Nginx keeps serving the frontend.
- One backend stopped → only its sockets close, they reconnect to the other
  instance and editing continues; 20/20 API calls succeed.
- The stopped backend restarts → Nginx sends it traffic again.
- Redis stopped → `/readyz` 503 naming `redis`, `/healthz` 200, Docker reports
  both backends healthy; Redis back → ready again.
- A 150-request burst from one IP → 85 refused by Nginx with JSON
  `RATE_LIMITED` and `Retry-After`.
- No ticket in the access log, no health probes in it, compact backend lines.

Two real browsers (headless Chrome) on the production build: Monaco renders and
both users see each other's typing, with **zero CSP violations**, served by
different backend instances (backend logs).

## Troubleshooting

| Symptom                                                                        | Cause / fix                                                                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Backends restart in a loop, log says `still holds the development placeholder` | Set real `JWT_SECRET` / `JWT_REFRESH_SECRET` in `.env`                                                          |
| Login works but every API call says the origin is not allowed                  | `STACK_CLIENT_URL` does not match the address in the browser                                                    |
| `failed to fetch oauth token … 500/504` during build                           | Docker Hub is having trouble; retry. Images already built still start with `docker compose --profile app up -d` |
| `migrate` exits non-zero                                                       | `docker compose --profile app logs migrate`; usually PostgreSQL credentials in `.env`                           |
| Port 8080 in use                                                               | `STACK_HTTP_PORT=8081` and `STACK_CLIENT_URL=http://localhost:8081` in `.env`                                   |

## Planned (Phase 14)

AWS: an ALB with WebSocket support in front of two or more backend tasks
(health check: `/readyz`), RDS for PostgreSQL, ElastiCache for Redis, secrets
from Parameter Store or Secrets Manager instead of an env file, HTTPS at the ALB
with HSTS. The same images; `migrate` becomes a one-off task before a deploy.
