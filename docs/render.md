# Render demo deployment

The root `render.yaml` defines one Node web service, PostgreSQL 17, and a
Redis-compatible Key Value instance in Singapore. All use free plans for a
temporary demo. Free PostgreSQL expires after 30 days; export data or upgrade
before expiry. The free web service sleeps when idle and needs time to wake up.

## Runtime

- The build installs dependencies, generates Prisma, and builds React.
- Startup applies committed Prisma migrations and starts Node. This initial
  configuration uses one instance. For a paid/scaled deployment, move migrations
  to Render's pre-deploy command.
- `SERVE_FRONTEND=true` makes Express serve `frontend/dist`, including SPA routes.
  REST, refresh cookies, bundled Monaco workers, and WebSockets share one origin.
- `CLIENT_URL` defaults to Render's `RENDER_EXTERNAL_URL` when running on Render.
  Set it explicitly to the HTTPS origin if adding a custom domain.
- Render generates independent JWT secrets and wires private datastore URLs.
- `/readyz` checks PostgreSQL and Redis. Node already handles SIGTERM and flushes
  open documents on graceful shutdown.
- The original local Docker/Nginx deployment still works with frontend hosting
  disabled (the default).

## Deploy

1. Commit and push the configuration and application changes to GitHub.
2. Open a Render Blueprint for `https://github.com/Hargun1/project1`.
3. Review the workspace and free plans, then apply the Blueprint.
4. Wait for the web deployment to become live, then verify `/healthz`, `/readyz`,
   registration, login, document creation, two-user editing, reload, and history.

Render CLI validation: `render blueprints validate render.yaml`.
JSON Schema validation is useful for structure but does not prove account plan
availability or that the workload starts successfully.

MongoDB Atlas is not required: the application uses PostgreSQL via Prisma,
including relational permissions, transactions, and binary Yjs snapshots.
