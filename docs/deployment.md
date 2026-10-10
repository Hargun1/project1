# Deployment

> **Implemented: Phase 12 (Docker images, Nginx, health checks) and Phase 14
> (HTTPS, horizontal scaling with replicas, image publishing, a production
> override).** The whole system runs from one `docker compose` command: Nginx in
> front of N backend replicas, PostgreSQL, Redis and a migration job. Deploying
> it to AWS is written up in [aws.md](aws.md) and has **not** been carried out
> (no AWS account was used).

## Two ways to run

| Mode                   | Command                                                                               | What runs where                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Development            | `npm run infra:up`, then `dev:backend` + `dev:frontend`                               | PostgreSQL + Redis in Docker; the app on the host with hot reload, Vite on :5173                    |
| Full stack (prod-like) | `npm run stack:up`                                                                    | Everything in Docker, production images, `NODE_ENV=production`, the app on <https://localhost:8443> |
| One real server        | `docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d` | Published images, ports 80/443, Let's Encrypt; see [aws.md](aws.md)                                 |

The stack uses the services of the `app` [Compose profile](https://docs.docker.com/compose/how-tos/profiles/),
so plain `docker compose up` still starts only the infrastructure.

```bash
cp .env.example .env
# The stack runs in production mode, which refuses the placeholder secrets:
#   JWT_SECRET=<openssl rand -hex 32>
#   JWT_REFRESH_SECRET=<openssl rand -hex 32>   (must differ)
npm run stack:up       # build images, start everything, wait until healthy
npm run stack:smoke    # 20 checks through Nginx (see below)
npm run stack:scale    # scale to 3 replicas and back with 9 live clients
npm run stack:logs     # follow every container's logs
npm run stack:down     # stop (the database volume is kept)
```

## Topology

```
  browser ──► nginx :8443 (HTTPS) ─┬─► backend-1 :4000 ─┐
              :8080 → redirect     ├─► backend-2 :4000 ─┼─► redis   (Pub/Sub, sessions, tickets, rate limits)
  (static files served by nginx)   └─► backend-N …      └─► postgres (users, documents, revisions)
                       migrate (one-shot) ────────────────► postgres
```

Only Nginx publishes ports (8080 for the redirect, 8443 for the app; 80/443 with
the production override). The backends are reachable only on the Compose
network, so every request passes through the proxy's limits and headers.

Start-up order is enforced with health conditions, not sleeps:

1. `postgres` and `redis` become **healthy** (`pg_isready`, `redis-cli ping`).
2. `migrate` runs `prisma migrate deploy` and must **exit 0**.
3. every `backend` replica starts and becomes **healthy** (`/healthz`).
4. `nginx` starts.

Running migrations in a separate one-shot service means replicas never race
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
`nginx:1.28-alpine` with the built files, the Nginx config, `openssl` (only for
the self-signed fallback certificate) and `40-tls.sh`: no Node, no
`node_modules`, no source. About 160 MB, most of it the Nginx base image.

`.dockerignore` keeps `node_modules`, build output, `.git` and **`.env`** out of
the build context, so secrets can never be baked into an image. Containers get
configuration from the environment at run time.

## Configuration

One `.env` at the repository root, as in development. The backends read it
through `env_file`, and Compose then overrides what must differ inside the
container network:

| Variable           | In the stack                                         | Why                                                        |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| `NODE_ENV`         | `production`                                         | Secure cookies, JSON logs, real-secret check               |
| `DATABASE_URL`     | built from `POSTGRES_*`, host `postgres`             | `localhost` inside a container is the container itself     |
| `REDIS_URL`        | `redis://redis:6379`                                 | same                                                       |
| `CLIENT_URL`       | `STACK_CLIENT_URL`, default `https://localhost:8443` | CORS, the CSRF Origin check and the WebSocket Origin check |
| `TRUST_PROXY_HOPS` | `1`                                                  | exactly one proxy (Nginx) in front                         |
| `LOG_LEVEL`        | `STACK_LOG_LEVEL`, default `info`                    |                                                            |

`STACK_HTTPS_PORT` (default 8443) and `STACK_HTTP_PORT` (default 8080) change
the published ports. If you change the HTTPS port, set `STACK_CLIENT_URL` to
match, or the Origin checks will refuse the browser. `BACKEND_REPLICAS`
(default 2) sets the number of backend instances.

Both `docker compose` and the backend validate configuration: the backend's
Zod schema refuses to start with placeholder secrets in production and names the
offending variable in the container log.

## Nginx

[`nginx/nginx.conf`](../nginx/nginx.conf) holds the shared settings and two
servers: port 80, which only redirects to HTTPS (and serves certificate
renewal challenges), and port 443, which serves the app. The app's routes are in
[`app-locations.conf`](../nginx/app-locations.conf), headers in
[`proxy-headers.conf`](../nginx/proxy-headers.conf) and
[`security-headers.conf`](../nginx/security-headers.conf), and
[`40-tls.sh`](../nginx/40-tls.sh) prepares the certificate and the redirect
before Nginx starts.

| Path                  | Behaviour                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `/`                   | `index.html` for every client-side route (SPA fallback), `Cache-Control: no-cache`                |
| `/assets/`            | hashed bundles, cached for a year (`expires 1y`)                                                  |
| `/api/`               | proxied to the backends, 30 req/s per IP (burst 60), JSON 429/503 for errors Nginx itself makes   |
| `/ws`                 | WebSocket upgrade, 50 concurrent sockets per IP, 120 s read timeout (the server pings every 30 s) |
| `/healthz`, `/readyz` | proxied to a backend, **not** access-logged                                                       |
| `/nginx-health`       | Nginx's own liveness, for its container healthcheck                                               |

### HTTPS (Phase 14)

- **Certificate:** if `TLS_CERT_DIR` (default `/etc/nginx/certs`, mounted from
  `nginx/certs/`) contains `fullchain.pem` and `privkey.pem`, they are used:
  Let's Encrypt in production, or a locally trusted one from
  [mkcert](https://github.com/FiloSottile/mkcert) (`mkcert -cert-file
nginx/certs/fullchain.pem -key-file nginx/certs/privkey.pem localhost`).
  Otherwise a self-signed certificate for `localhost` is generated at start-up,
  so the stack works out of the box and in CI (browsers warn about it).
- **Port 80** answers `/nginx-health` and `/.well-known/acme-challenge/` (for
  `certbot --webroot`) and redirects everything else to HTTPS with a 301,
  keeping path and query (`PUBLIC_HTTPS_PORT` decides the port in the redirect).
- **TLS 1.2 and 1.3 only** (1.1 refused, checked), HTTP/2 enabled, shared
  session cache.
- **HSTS** (`max-age` one year) on real host names only. Never for `localhost`
  or `127.0.0.1`: HSTS applies to a host name on _every_ port, so it would force
  HTTPS on every other project a developer runs on localhost.
- The refresh cookie is `Secure` (production mode) and now really travels over
  TLS; the browser test covers a reload restoring the session over HTTPS.

### Scaling (Phase 14)

One `backend` service with `deploy.replicas` (default 2). Nginx's upstream has a
single entry, `server backend:4000 resolve`: Docker's DNS answers `backend` with
the address of every running replica and Nginx re-resolves every 5 s, so

```bash
docker compose --profile app up -d --scale backend=3
```

adds an instance that receives traffic within seconds, with no configuration
change. Scaling in (`--scale backend=2`) stops the removed replica with SIGTERM:
it shuts down gracefully (sockets closed with 4008, documents flushed), its
users reconnect to the remaining instances, and Nginx stops routing to it once
DNS no longer lists it. `npm run stack:scale` demonstrates both directions with
nine live clients (9/9 checks, also in CI): they spread 3/3/3 over three
instances and every edit reaches all of them.

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
- **Failover is not seamless per request** (measured in Phase 13). In the first
  seconds after an instance stops, a request Nginx has already sent towards it
  can fail once (503/504 after the 3 s connect timeout) instead of being retried
  on the other instance; the Nginx log showed this for requests in flight while
  the stopped container dropped out of DNS. Clients recover: the browser client
  retries ticket requests and reconnects with backoff, so a user sees one
  reconnect. The resilience test connects the same way and reports the retries
  it needed (0 or 1 in our runs).

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
  events carry the instance id (`<container id>:4000`), and `docker compose
logs backend` prefixes every line with the replica (`backend-2 |`).

Nginx's _error_ log prints the request line of a failed upstream attempt,
query string included, so a failed `/ws` attempt can show a ticket. Tickets are
single-use and expire in 30 s, and a retry on another instance consumes it.

## Verified

`npm run stack:smoke` (also in CI): Nginx liveness; `/healthz` and `/readyz`
proxied; HTTP redirecting to HTTPS; no HSTS on localhost; the built frontend at
`/` with CSP and security headers, no Nginx
version, `no-cache`; SPA fallback for deep links; hashed assets cached a year;
registration through the proxy with a `Secure`, `HttpOnly`, `Path=/api/auth`
cookie; the backend reusing Nginx's request id; `no-store` on the API; JSON
error envelope through the proxy; four WebSocket clients spread over both
instances, an edit reaching all of them, a late joiner receiving the document.

Failure scenarios on the running stack, `npm run stack:resilience` (21 checks;
see [testing.md](testing.md)):

- `docker stop` → SIGTERM reaches Node, sockets close with 4008, and an edit
  made 300 ms earlier (inside the 2 s save debounce) is still there after
  restart. Every shutdown logs `WebSocket server closed`; none hits the
  force-exit.
- Both backends down → the API answers JSON `503 SERVICE_UNAVAILABLE` with
  `Retry-After`; Nginx keeps serving the frontend.
- One backend stopped → only its sockets close, they reconnect to the other
  instance (one retry, see above) and editing continues; 20/20 API calls
  succeed.
- The stopped backend restarts → Nginx sends it traffic again.
- Redis stopped → `/readyz` 503 naming `redis`, `/healthz` 200, Docker reports
  both backends healthy; Redis back → ready again.
- A 150-request burst from one IP → 85 refused by Nginx with JSON
  `RATE_LIMITED` and `Retry-After`.
- No ticket in the access log, no health probes in it, compact backend lines.

Two real browsers on the production build, `npm run stack:e2e` (15 checks, also
in CI): sign-up, dashboard and Share dialog through the real UI, both users see
each other's typing and presence, a reload keeps the session and the text,
**zero CSP violations**, served by different backend instances (backend logs).

## Troubleshooting

| Symptom                                                                        | Cause / fix                                                                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Backends restart in a loop, log says `still holds the development placeholder` | Set real `JWT_SECRET` / `JWT_REFRESH_SECRET` in `.env`                                                          |
| Login works but every API call says the origin is not allowed                  | `STACK_CLIENT_URL` does not match the address in the browser                                                    |
| `failed to fetch oauth token … 500/504` during build                           | Docker Hub is having trouble; retry. Images already built still start with `docker compose --profile app up -d` |
| `migrate` exits non-zero                                                       | `docker compose --profile app logs migrate`; usually PostgreSQL credentials in `.env`                           |
| Port 8443 or 8080 in use                                                       | `STACK_HTTPS_PORT=8444` (and `STACK_CLIENT_URL=https://localhost:8444`) or `STACK_HTTP_PORT=8081` in `.env`     |
| The browser warns about the certificate                                        | Expected with the generated self-signed one; use mkcert (see HTTPS above) for a trusted local certificate       |

## Continuous delivery (Phase 14)

When every CI job has passed on `main`, the `publish` job pushes three images
to GitHub Container Registry, each tagged with the commit SHA and `latest`:
`ghcr.io/<owner>/<repo>/backend`, `…/migrate`, `…/web`. A server deploys a
version by pulling those tags with `docker-compose.prod.yml`; nothing is built on
the server, so what runs is exactly what CI tested.

## Production override

`docker-compose.prod.yml` adapts the stack to one real server: registry images
(`IMAGE_PREFIX`, `IMAGE_TAG`), Nginx on ports 80/443 with the Let's Encrypt
certificate for `DOMAIN`, PostgreSQL and Redis **not** published to the host,
`CLIENT_URL=https://DOMAIN`. Rehearsed locally: with the images tagged under a
registry-style name, `DOMAIN=localhost` and `PULL_POLICY=missing`, it started on
80/443 with the database ports closed, and the smoke and browser tests passed
against `https://localhost`.

## AWS

Not deployed. The step-by-step plan (one EC2 server first, then an Application
Load Balancer with two instances, RDS and ElastiCache), with costs, teardown and
the configuration differences, is in [aws.md](aws.md).
