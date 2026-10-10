# Authentication

> **Implemented in Phase 2.**

## Overview

The authentication system provides secure user registration, login, token-based
session management, and route protection. It follows the architecture described
in the project specification (§10, §11, §12).

## Password hashing

Passwords are hashed with **bcrypt** using 12 salt rounds (~250 ms per hash on a
modern machine). Plaintext passwords are never stored, logged, or returned in any
response. The `password`, `passwordHash`, and all token fields are stripped from
Pino logs via the `redact` configuration in `backend/src/utils/logger.js`.

## Token architecture

| Token         | Lifetime | Storage              | Sent as                   |
| ------------- | -------- | -------------------- | ------------------------- |
| Access token  | 15 min   | In-memory (frontend) | `Authorization: Bearer …` |
| Refresh token | 7 days   | HttpOnly cookie      | `collab_refresh` cookie   |

- **Access tokens** are stateless JWTs signed with `JWT_SECRET`. They carry
  `sub` (user ID), `email`, and `name` in the payload.
- **Refresh tokens** are JWTs signed with `JWT_REFRESH_SECRET` and carry a
  unique `jti` (JWT ID). Each `jti` maps to a Redis key (`refresh:<jti>`) that
  stores the user ID with a TTL equal to the token lifetime.

### Refresh-token rotation

On every `/api/auth/refresh` call:

1. The old refresh token is verified.
2. Its `jti` session is read **and deleted in one atomic `GETDEL`**. If it is
   missing, the session was revoked or already used.
3. A new access + refresh token pair is issued.
4. The new refresh session is stored in Redis.

Atomicity is what makes "single use" true. With a separate `GET` then `DEL`, two
requests presenting the same token can both read the session before either
deletes it, and both rotate successfully. Verified end to end: two parallel
`/refresh` calls with one cookie return exactly one `200` and one `401`.

So a stolen refresh token can be used at most once, and only until the real
owner's next refresh invalidates it.

### Cookie settings

| Attribute  | Development         | Production  |
| ---------- | ------------------- | ----------- |
| `httpOnly` | `true`              | `true`      |
| `secure`   | `false` (localhost) | `true`      |
| `sameSite` | `lax`               | `strict`    |
| `path`     | `/api/auth`         | `/api/auth` |

The cookie path is scoped to `/api/auth` so it is only sent on auth endpoints,
not every request.

## API endpoints

```
POST /api/auth/register   → 201  { user, accessToken } + cookie
POST /api/auth/login      → 200  { user, accessToken } + cookie
POST /api/auth/refresh    → 200  { accessToken }       + rotated cookie
POST /api/auth/logout     → 204  (clears cookie, invalidates Redis session)
GET  /api/auth/me         → 200  { user }  (protected — requires Bearer token)
```

All payloads are validated with Zod schemas (`registerSchema`, `loginSchema`)
before reaching business logic. Invalid input returns a 422 with field-level
error details.

## Auth middleware

`backend/src/middleware/authenticate.js` extracts the `Authorization: Bearer`
header, verifies the JWT, and attaches `req.user = { id, email, name }` to the
request. Protected routes use this middleware; the centralized error handler
returns a 401 with the shared error envelope on failure.

## Frontend integration

- **AuthContext** holds the current `user` and an in-memory `accessToken` ref.
- On mount, `AuthProvider` attempts a silent refresh: if the browser has a valid
  refresh cookie, the user is rehydrated without seeing the login page.
- `ProtectedRoute` redirects to `/login` if the user is not authenticated.
- `GuestRoute` redirects to `/dashboard` if the user is already authenticated.
- The access token is never stored in `localStorage` — it lives in a React ref
  and is lost on page reload (by design; the refresh cookie recovers it).
- Callers obtain it through `getAccessToken()`, which refreshes first when the
  token has under 60 s left (it reads the JWT's `exp` claim; it does not and
  cannot verify the signature). Long-lived pages depend on this: the editor can
  stay open for hours and needs a valid token every time the WebSocket
  reconnects and mints a new ticket.
- Concurrent refreshes share one in-flight request. Because rotation is
  single-use, two simultaneous refreshes (React StrictMode mounts effects twice
  in development) would otherwise race, and the loser would be logged out.

## Environment variables

| Variable                       | Description                           | Default  |
| ------------------------------ | ------------------------------------- | -------- |
| `JWT_SECRET`                   | Access token signing key (≥32 chars)  | required |
| `JWT_REFRESH_SECRET`           | Refresh token signing key (≥32 chars) | required |
| `REFRESH_TOKEN_EXPIRY_SECONDS` | Redis TTL for refresh sessions        | 604800   |

Both secrets are validated at startup with Zod. The server refuses to start if
they are missing, too short, identical to each other, or still contain the
placeholder value in production.

## WebSocket authentication

WebSocket authentication is deliberately separate and covered in
[collaboration.md](collaboration.md): a single-use, short-TTL ticket is used
because a raw JWT in a WebSocket URL would end up in access logs and browser
history (§11).
