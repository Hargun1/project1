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

## Implemented (Phases 2–9)

- **bcrypt** password hashing (12 rounds); plaintext is never stored or logged.
- **JWT access tokens** (15 min) and a **rotating refresh token** in an
  `HttpOnly` cookie scoped to `/api/auth`, `Secure` + `SameSite=Strict` in
  production. Rotation consumes the old session atomically (`GETDEL`), so a
  refresh token is genuinely single-use. Verified end to end.
- **Single-use WebSocket tickets**: 32 random bytes, 30 s TTL, bound to one
  (user, document) pair, consumed with `GETDEL`. A replayed ticket is closed
  with `4001`. Tested.
- **WebSocket authorisation**: membership and role are re-read from PostgreSQL
  on every connection; non-members get `4003`, missing or deleted documents
  `4004`. Edits from a `VIEWER` are refused per message on the server. Tested.
- **WebSocket input validation**: every inbound message is parsed against a Zod
  discriminated union, base64 is checked strictly, and Yjs updates are fully
  decoded _before_ being applied, so a corrupt payload never touches the shared
  document. Inbound frames are capped at 1 MiB. Tested.
- **No document content over REST**: content changes only through the
  role-checked sync protocol, and the binary state column is never serialised
  into API responses.
- **Malformed ids**: a non-UUID document id is a 404, not a database cast error.
- **Revision endpoints (Phase 9)**: every member may read history, OWNER and
  EDITOR may save versions, only the OWNER may restore — checked on the server
  for every request, with a 404 for a revision that belongs to a different
  document. Snapshots are decoded server-side; binary CRDT state is never sent
  to the browser. Every role × action combination is covered by route tests.
- **Cross-instance messages (Phase 8)** are validated with Zod before use, and
  undecodable Yjs payloads are dropped, so a malformed message on a Redis
  channel cannot crash an instance or corrupt a document. Tested. Presence
  ownership is tracked across instances, so a client cannot remove a cursor
  belonging to a user connected to a different instance. Tested.
- **Presence integrity (Phase 7)**: awareness updates are decoded and
  Zod-validated before they are applied; the claimed `user.id`/`user.name` must
  match the authenticated socket; a connection cannot modify another user's
  awareness entry and may own at most three entries. Tested, including a forged
  removal of another user's cursor.
- **No CSS/HTML injection from presence**: names are rendered as React text, and
  the generated cursor CSS hex-escapes every non-alphanumeric character and
  accepts only `#rrggbb` colours and integer client ids. Unit-tested with
  hostile names.

## Planned, not implemented

| Control                                                   | Phase |
| --------------------------------------------------------- | ----- |
| Member management; revoking an open socket on role change | 10    |
| Rate limiting (REST, WS connections, WS messages; Redis)  | 11    |
| `MAX_DOCUMENT_SIZE_BYTES` enforced on the Y.Doc           | 11    |
| CSRF strategy write-up, Content-Security-Policy tuning    | 11    |

## Standing rules

- No secrets in the repository. `.env` is git-ignored; `.env.example` carries
  placeholders only.
- All external input is validated with Zod at the trust boundary — HTTP bodies,
  query parameters, and WebSocket messages.
- Frontend authorization is UX only. Every decision is re-made on the server.
- Passwords, JWT secrets, refresh tokens and document contents are not logged.
