# Deployment

> **Not implemented yet.** Phase 1 containerises **dependencies only**
> (PostgreSQL + Redis). Application Dockerfiles and Nginx arrive in Phase 12;
> AWS in Phase 14.

## Today

```bash
npm run infra:up     # docker compose up -d  → PostgreSQL + Redis
npm run db:migrate   # apply the schema
npm run dev:backend  # node --watch, port 4000
npm run dev:frontend # vite, port 5173, proxying the API
```

Both containers declare healthchecks, so `docker compose ps` distinguishes
"started" from "actually accepting connections" — which is what
`/readyz` reports to the application layer.

Redis runs with `--appendonly no --save ''`: persistence is switched off
deliberately, as a structural reminder that it holds no durable state.

## Planned (Phase 12)

- Multi-stage Dockerfiles for backend and frontend, non-root users, production
  dependencies only in the final image.
- Nginx serving the built client, proxying `/api` and upgrading `/ws`.
- `docker compose up` bringing the whole system up on one command, including two
  backend instances to exercise the Redis fan-out path.

## Planned (Phase 14)

AWS: ALB with WebSocket support in front of two or more backend tasks, RDS for
PostgreSQL, ElastiCache for Redis, secrets from Parameter Store or Secrets
Manager rather than environment files. `npm run db:deploy` applies migrations;
`prisma migrate dev` is never run against a deployed database.
