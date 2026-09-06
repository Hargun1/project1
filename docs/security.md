# Security

This file separates what is **implemented and verified** from what is only
planned. The distinction is deliberate: an unimplemented control described as
working is worse than no control, because it stops anyone from looking for it.

## Implemented (Phase 1)

- **Helmet** security headers; `x-powered-by` removed. Covered by a test
  asserting `x-content-type-options: nosniff` and the absence of the header.
- **CORS** restricted to `CLIENT_URL` with credentials enabled — not `*`.
- **Body size limit** of 100 kB, returning a typed `PAYLOAD_TOO_LARGE`
  (413) rather than an unhandled parser error. Covered by a test.
- **Environment validation** with Zod at startup: required variables, URL
  schemes, minimum 32-character secrets, `JWT_REFRESH_SECRET` must differ from
  `JWT_SECRET`, and placeholder secrets are rejected when `NODE_ENV=production`.
  The process exits with a readable list rather than booting half-configured.
- **Log redaction**: `authorization`, `cookie`, `set-cookie`, `password`,
  `passwordHash`, `token`, `accessToken`, `refreshToken` and `ticket` are removed
  from log output, not merely masked.
- **Error handling** that never returns a stack trace or a raw database error in
  production. Unknown errors become a generic 500; only `AppError`s marked
  exposable return their own message.
- **Request id** on every response and in every error body, with inbound ids
  validated against `^[A-Za-z0-9._-]{8,128}$` so a client cannot inject
  newlines into logs. Covered by a test.
- `trust proxy` set to 1, so client IPs are correct behind Nginx (which matters
  for rate limiting later).

## Planned, not implemented

| Control                                              | Phase |
| ---------------------------------------------------- | ----- |
| Argon2id/bcrypt password hashing                     | 2     |
| JWT access tokens + rotating HttpOnly refresh cookie | 2     |
| Single-use short-TTL WebSocket tickets               | 5 / 8 |
| Server-side RBAC on both HTTP and WebSocket paths    | 10    |
| Rate limiting (Redis-backed)                         | 11    |
| Document size caps enforced at the socket layer      | 11    |

## Standing rules

- No secrets in the repository. `.env` is git-ignored; `.env.example` carries
  placeholders only.
- All external input is validated with Zod at the trust boundary — HTTP bodies,
  query parameters, and WebSocket messages.
- Frontend authorization is UX only. Every decision is re-made on the server.
- Passwords, JWT secrets, refresh tokens and document contents are not logged.
