# Authentication

> **Not implemented yet — Phase 2.** This file records the intended design so it
> can be reviewed before it is built. Nothing described here exists in code.

## Planned design

- Registration and login validated with Zod at the route boundary; passwords
  hashed with Argon2id (bcrypt as the fallback if the native build is a problem
  on the target platform). Plaintext passwords are never stored or logged.
- A short-lived **access token** (JWT, ~15 min) returned in the response body and
  sent as `Authorization: Bearer …`.
- A long-lived **refresh token** in an `HttpOnly` + `Secure` + `SameSite` cookie,
  rotated on every use so a stolen token is usable at most once. It is a cookie
  rather than `localStorage` specifically so JavaScript cannot read it.
- `JWT_SECRET` and `JWT_REFRESH_SECRET` are distinct, minimum 32 characters, and
  already validated at boot — the server refuses to start in production while
  either still contains a placeholder.
- Auth middleware attaches a typed user to the request; every protected route
  reads identity from the verified token, never from a client-supplied field.

WebSocket authentication is deliberately separate and covered in
[collaboration.md](collaboration.md): a single-use, short-TTL ticket, because a
raw JWT in a WebSocket URL would end up in access logs and browser history.
