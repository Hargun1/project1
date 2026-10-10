# syntax=docker/dockerfile:1
#
# Backend image (Phase 12). Build from the repository root, because the backend
# depends on the `shared` workspace:
#
#   docker build -f backend/Dockerfile -t collab-editor-backend .
#
# Stages:
#   base       Debian slim + OpenSSL (Prisma's query engine links against it)
#   build      every dependency incl. dev tools, Prisma client generated.
#              Also the image the one-shot `migrate` service runs, because
#              `prisma migrate deploy` needs the Prisma CLI (a dev dependency).
#   prod-deps  production dependencies only
#   runtime    what actually runs: prod node_modules + the generated Prisma
#              client + source. No compilers, no dev tools, no Prisma CLI,
#              running as the unprivileged `node` user.
#
# There is no compile step: the project is plain JavaScript (ESM), so the
# "multi-stage build" exists to keep dev dependencies and build tools out of
# the image that runs in production.

ARG NODE_VERSION=24

# Debian (glibc) rather than Alpine (musl): Prisma's engines and bcrypt ship
# prebuilt glibc binaries, so nothing is compiled and nothing needs patching.
FROM node:${NODE_VERSION}-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Manifests first, source later: the expensive `npm ci` layer is reused from
# cache until a package.json or the lockfile changes. All three workspace
# manifests are needed for npm to validate the lockfile.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

FROM manifests AS build
RUN npm ci --workspace @collab/backend --include-workspace-root=false
COPY shared/src shared/src
COPY backend/prisma backend/prisma
COPY backend/prisma.config.js backend/
RUN npm run db:generate --workspace @collab/backend
COPY backend/src backend/src

FROM manifests AS prod-deps
# `--omit=optional` as well as `--omit=dev`: the Prisma CLI is a dev dependency
# here but also an *optional peer* of @prisma/client, which npm records as
# "devOptional" and keeps unless both are omitted. Without it the image carried
# ~110 MB of CLI it never runs. Nothing the backend needs at runtime is optional.
RUN npm ci --omit=dev --omit=optional --workspace @collab/backend --include-workspace-root=false \
  && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production
# Code and dependencies stay owned by root and are only readable by the app user:
# a compromised process cannot rewrite its own code.
COPY --from=prod-deps /app/node_modules ./node_modules
# The generated Prisma client (JS + the query engine for this platform).
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY package.json ./
COPY shared/package.json shared/
COPY shared/src shared/src
COPY backend/package.json backend/
COPY backend/src backend/src

USER node
WORKDIR /app/backend
EXPOSE 4000

# Liveness only (/healthz touches no dependency), so a database blip never marks
# the container unhealthy. Readiness (/readyz) is for load balancers. `fetch` is
# built into Node, so the image needs no curl.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec form: node receives SIGTERM directly (no shell in between), so the
# graceful shutdown in server.js runs on `docker stop`.
CMD ["node", "src/server.js"]
