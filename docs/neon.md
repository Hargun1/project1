# Neon PostgreSQL setup

Target: organization `org-round-cake-24875639`, project `sweet-bonus-39842799`,
branch `production` (`br-dry-pond-b4fn6xhi`), database `neondb`.

The existing Prisma 6 client and migrations are retained. The Node/Express host
uses its normal TCP PostgreSQL driver and pooled `DATABASE_URL`. Prisma CLI uses
`DATABASE_URL_UNPOOLED` when provided. No Auth, Data API, Functions, or storage
services are needed; `neon.ts` therefore declares no additional services.

The backend and Prisma CLI load root `.env.local`, then `.env`, without
overwriting existing process environment variables. Local Neon credentials are
in ignored `.env.local`; existing local Docker settings remain in `.env`.
Render continues to inject its environment variables independently.

## Finish CLI setup from your terminal

```powershell
npx --yes neon@latest init -y --org-id org-round-cake-24875639 --project-id sweet-bonus-39842799 --branch production --services postgres
npx --yes neon@latest deploy
npm run db:deploy
npm run build
npm run dev:backend
```

Complete browser sign-in if requested. If sign-in fails, run `npx neon@latest login`
and retry. The CLI may pull Neon variables into the existing `.env`; keep the
same branch in `.env.local` or remove that local override when switching branches.

## Verification and cutover

`GET /readyz` must return 200 with database and Redis both `up`. Then verify
registration, login, document creation, collaboration, reload, and revisions.
The local integration suite uses a disposable `_test` database, not `neondb`.

Do not switch Render's `DATABASE_URL` to this database until migrations succeed
and existing Render users/documents/revisions have been copied and checked.
Also update the Blueprint's database environment-variable reference so a later
Blueprint sync cannot restore the old Render connection. Keep the old database
until the new deployment and preserved data have been verified.

## Status of this setup attempt

- Neon connector verified the specified project and ready production branch.
- The production database contains all three applied Prisma migrations, verified
  after the user ran the migration command from their terminal. Application
  tables were still empty at verification time.
- Prisma generation succeeded.
- This session's local Prisma connection failed with P1001 (cannot reach Neon
  on port 5432); the user's terminal successfully applied the migrations.
- The app started on port 4010; liveness returned 200, readiness returned 503
  with database down and Redis up.
- The user approved a fresh start. Render's web service now points to Neon;
  deployment `dep-dbh3vdou01pc73fh4et0` became live and its migration logs confirm
  `neondb` with no pending migrations. The old Render database was retained.
- The currently deployed commit predates the local Prisma config changes, so
  Render uses the direct endpoint for both runtime and migrations. This is valid
  for the existing single, long-running Prisma process. After the prepared code
  is pushed, runtime can use the pooled URL with the separate direct migration URL.
- The Blueprint now leaves both database connection variables in Dashboard
  configuration; syncing it will no longer restore the old database reference.
  This Blueprint change is still local and must be committed and pushed before
  another Blueprint sync.

Run live API/WebSocket verification (creates two test accounts and one document):

```powershell
node scripts/verify-neon.mjs https://collab-editor-hargun.onrender.com
```

The live attempt passed readiness, two registrations, login, refresh, document
creation, and sharing. WebSocket connections from this agent session failed
with OS `EACCES` on port 443, so collaboration, revisions, and reconnect checks
in that script were not reached. Those checks need a normal terminal or browser.
