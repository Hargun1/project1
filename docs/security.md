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

## Implemented (Phases 2–10)

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

- **Role-based access control (Phase 10):** one permission matrix
  (`shared/src/permissions.js`) enforced on every REST request through
  `access.service.js`, with roles read from PostgreSQL per request. Only the
  OWNER manages members; OWNER can never be granted, changed or removed, so a
  document always has exactly one owner; any other member may leave. Invites
  require an existing account (no email delivery). Every role × action
  combination is covered by route tests.
- **Live revocation (Phase 10, §42):** access changes are announced on a Redis
  channel and every instance re-checks the affected sockets against the
  database (downgrade → `role` message and refused edits; removal → close
  `4003`; deletion → close `4004`), plus a 60 s periodic re-check per socket.
  Verified end to end across two real instances, and each mechanism was
  mutation-checked.

## Implemented (Phase 11: hardening)

### Rate limiting (§28)

| Limit                         | Key                | Default           | Where                                    |
| ----------------------------- | ------------------ | ----------------- | ---------------------------------------- |
| Auth endpoints                | client IP          | 20 / minute       | register, login, refresh, logout         |
| Login attempts                | email (normalised) | 10 / 15 minutes   | login                                    |
| Authenticated API             | user id            | 300 / minute      | everything under `/api/documents`        |
| WebSocket connection attempts | client IP          | 30 / minute       | the HTTP upgrade, before a socket exists |
| WebSocket messages            | the socket         | 40 / s, burst 200 | every inbound frame                      |

All numbers are environment variables validated at startup (`RATE_LIMIT_*`,
`WS_MESSAGES_PER_SECOND`, `WS_MESSAGE_BURST`).

- **Shared across instances.** HTTP and connection counters live in Redis
  (`INCR` + `PEXPIRE NX` in one `MULTI`), so spreading requests over several
  backends does not multiply the allowance. Verified on two real instances.
- **Fixed windows** for HTTP and connections (simple, explainable; a burst at a
  window boundary can reach 2× briefly). A **token bucket** per socket for
  messages: allows typing bursts, caps the sustained rate, needs no shared store.
- **Responses:** `RateLimit-Limit/Remaining/Reset` on every limited request; a
  refusal is `429` with `Retry-After` in the shared error envelope. Refused
  WebSocket upgrades get a plain HTTP `429`.
- **Message floods close the socket** with `4029` (retryable) rather than
  dropping messages: a dropped edit would leave that client diverged, while a
  reconnect re-syncs through state vectors and loses nothing.
- **Client IP** comes from `X-Forwarded-For` exactly as far as
  `TRUST_PROXY_HOPS` trusted proxies reach (default 1, for Nginx); entries further
  left were written by the client and could be forged. HTTP and WebSocket use
  the same rule.
- **Fails open:** if Redis is unreachable, limits are not enforced and a warning
  is logged, rather than refusing all traffic. (Login and refresh need Redis
  anyway; the documents API keeps working.)

### Document size cap (§12)

`MAX_DOCUMENT_SIZE_BYTES` (default 1 MiB) is enforced in the collaboration hub
**before** an update is applied, so a refused update never touches the shared
document. Measuring the encoded document on every keystroke would be too
expensive, so the hub keeps an estimate: exact after loading and after every
save (at least every 10 s while editing), plus the size of each update since.
The client receives `DOCUMENT_TOO_LARGE`, discards its local copy and re-syncs,
so it cannot keep showing (or re-send) text nobody else has. Verified end to
end: the update crossing the cap was refused and never reached the other
instance. The 1 MiB WebSocket frame limit (`maxPayload`) remains as a transport
guard.

### CSRF strategy

- Only `/api/auth/*` authenticates with a cookie (the refresh token). Every
  other endpoint requires an `Authorization` header, which a foreign page cannot
  make the browser add, so they are not CSRF-able by construction.
- The refresh cookie is `HttpOnly`, `SameSite` (Strict in production) and
  scoped to `Path=/api/auth`.
- **Origin check:** every state-changing request to `/api/auth/*` whose `Origin`
  is not the frontend (`CLIENT_URL`) is refused with 403. Requests without
  `Origin` (non-browser clients) are allowed: they cannot carry a victim's cookie.
- No CSRF tokens: with header-based auth plus the two layers above they would
  add complexity without closing a remaining hole.

### WebSocket abuse protection

- Upgrades are handled manually (`noServer`): wrong path → 404, foreign `Origin`
  → 403 (cross-site WebSocket hijacking), too many attempts → 429, all before a
  socket is allocated.
- Then ticket authentication, membership re-check, per-message validation,
  per-message permissions, the message rate limit, the 1 MiB frame cap and the
  document size cap.

### Authentication fixes found during hardening

- **Login timing leak:** an unknown email used to be answered instantly, a wrong
  password after a ~250 ms bcrypt comparison, revealing which emails have
  accounts despite identical messages. Unknown emails now pay for a comparison
  against a dummy hash, which is created at startup (created lazily, the first
  such login after each restart took 2×: measured 603 ms vs 322 ms). Measured
  after the fix: 232 ms vs 240 ms.
- **bcrypt's 72-byte limit:** bcrypt ignores everything after the first 72 bytes
  of a password. Registration now rejects passwords over 72 UTF-8 bytes, and
  login caps input at 1,024 characters.

### Other

- `Cache-Control: no-store` on every `/api` response (private data and tokens
  must not be cached by browsers or proxies).
- A resilience fix found while testing: an instance started while Redis was
  down never subscribed to access-change announcements (ioredis only
  re-subscribes channels that once subscribed successfully). The hub now
  subscribes again every time Redis comes back. Regression test in
  `cluster.test.js`.

## Implemented (Phase 12: the edge)

Nginx serves the page and is the only port browsers reach
([nginx/security-headers.conf](../nginx/security-headers.conf)).

**Content-Security-Policy** on the HTML page and its assets:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self' data:; connect-src 'self';
worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'none'
```

- `script-src 'self'`: no inline scripts and no third-party script origins.
  This is possible because Monaco is bundled rather than loaded from a CDN, and
  Vite's production `index.html` contains no inline script.
- `style-src 'unsafe-inline'` is the one relaxation: Monaco and the remote-cursor
  colours inject `<style>` elements at runtime. Injected styles cannot run code;
  the script policy stays strict.
- `connect-src 'self'` covers `fetch` and the WebSocket (CSP Level 3 matches
  `ws:`/`wss:` on the same host).
- `frame-ancestors 'none'` (and `X-Frame-Options: DENY`) prevents clickjacking.
- Verified in a real browser (headless Chrome) on the production build: two
  users editing, Monaco and its workers running, **zero** CSP violations.

Also: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `Permissions-Policy` (no camera, microphone,
geolocation), `Cross-Origin-Opener-Policy: same-origin`, `server_tokens off`.

**Coarse limits at the edge:** 30 requests/s per IP on `/api` (burst 60) and 50
concurrent WebSockets per IP, answered in the API's JSON envelope. Deliberately
generous; the precise user-, email- and socket-aware limits stay in the backend
(Phase 11).

**Network exposure:** the backends are reachable only on the Compose network;
browsers reach Nginx alone. (PostgreSQL and Redis still publish their ports to
the host for development tools; a cloud deployment would not.)

**Images:** run as non-root (`node`), code owned by root, no dev tools or
compilers in the runtime image, `.env` excluded from every build context.

## Found by the Phase 13 tests

- **Duplicate-registration race:** two sign-ups for one email at the same time
  both passed the "already registered?" check, and the second insert hit the
  unique index unhandled (500). The repository now maps the unique violation to
  a 409. The index, not the check, is the guarantee.
- **Ticket single use:** `consumeTicket` fell back to `GET` + `DEL` on any
  `GETDEL` error. That pair is not atomic, so two racing handshakes could both be
  admitted with one ticket (shown by a mutation test). The fallback was removed:
  Redis 7 is pinned, and a Redis error now fails the handshake with a retryable
  close code.

Both are covered by integration tests against real PostgreSQL and Redis
([testing.md](testing.md)).

## Planned, not implemented

| Control                                                     | Phase |
| ----------------------------------------------------------- | ----- |
| HTTPS at the load balancer, HSTS, `Secure` cookies over TLS | 14    |
| Secrets from a secrets manager instead of an env file       | 14    |

## Standing rules

- No secrets in the repository. `.env` is git-ignored; `.env.example` carries
  placeholders only.
- All external input is validated with Zod at the trust boundary — HTTP bodies,
  query parameters, and WebSocket messages.
- Frontend authorization is UX only. Every decision is re-made on the server.
- Passwords, JWT secrets, refresh tokens and document contents are not logged.
