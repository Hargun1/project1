# syntax=docker/dockerfile:1
#
# Web image (Phase 12): the built React app served by Nginx, which is also the
# reverse proxy and load balancer in front of the backend instances. Build from
# the repository root (the app imports the `shared` workspace and the Nginx
# config lives in /nginx):
#
#   docker build -f frontend/Dockerfile -t collab-editor-web .
#
# Stage 1 needs Node and every build tool; stage 2 is Nginx plus static files.
# None of Node, node_modules or the source reaches the final image.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace @collab/frontend --include-workspace-root=false
COPY shared/src shared/src
COPY frontend/ frontend/
# Empty = same origin: the browser calls /api and /ws on the host that served
# the page, and Nginx routes them. Baked in at build time (Vite inlines it).
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build --workspace @collab/frontend

# 1.28 (stable): first stable line whose open-source build re-resolves upstream
# host names at runtime (`server ... resolve`), so a restarted backend container
# with a new IP is found again without reloading Nginx.
FROM nginx:1.28-alpine AS runtime
# openssl: only to make a self-signed certificate when none is mounted (40-tls.sh).
RUN apk add --no-cache openssl
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/proxy-headers.conf nginx/security-headers.conf nginx/app-locations.conf /etc/nginx/snippets/
# Runs before Nginx starts: certificate + HTTP→HTTPS redirect (Phase 14).
COPY --chmod=755 nginx/40-tls.sh /docker-entrypoint.d/40-tls.sh
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80 443
# Port 80 answers /nginx-health itself (no redirect), so the probe needs no TLS.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1/nginx-health"]
