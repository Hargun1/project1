# Scaling

> **Implemented: Phase 8 (cross-instance collaboration over Redis Pub/Sub).**
> Running the instances behind Nginx is Phase 12; deploying them to AWS is
> Phase 14.

## Why the design scales at all

Because merging is a CRDT property rather than a server responsibility, a backend
instance never has to be the single ordering authority for a document. Instances
are therefore interchangeable, and adding one is a capacity change rather than an
architecture change.

- **Stateless HTTP.** Identity comes from a verified token on each request;
  refresh sessions and WebSocket tickets live in Redis. Any instance can serve
  any request, and a ticket minted by one instance is redeemed by another.
- **No sticky sessions.** A socket lands on whichever instance the load balancer
  picks. That instance loads the document's `Y.Doc` and joins the document's
  Redis channel.
- **Redis as transport, never storage.** Losing Redis costs live fan-out between
  instances, never document content.
- **Bounded memory.** A session is evicted once its last local socket has left
  and its state is saved, so memory follows the documents open _on this
  instance_, not all documents.

## How instances stay in sync

```
 Alice ──ws──▶ Instance A                                Instance B ◀──ws── Bob
               Y.Doc(doc 42) ──PUBLISH document:42──▶ Redis ──▶ Y.Doc(doc 42)
               Y.Doc(doc 42) ◀──────────────────────  Redis ◀── PUBLISH
                      │                                              │
                      └────── merge-on-save ──▶ PostgreSQL ◀── merge-on-save
```

`backend/src/services/collaboration.service.js` is a hub with one `Y.Doc` per
open document. Local edits are applied, forwarded to local sockets, and
published on `document:<id>`. Updates arriving from Redis are applied with a
`REDIS_ORIGIN` tag, which forwards them to local sockets but never republishes
them, so there is no echo loop. Presence (awareness) travels the same way.

**Wire format.** The same JSON envelope as the WebSocket, binary payload in
base64 (`backend/src/redis/bus-messages.js`):

```json
{ "v": 1, "from": "host:4000", "to": null, "type": "update", "data": "AQLq…" }
```

That is a deliberate simplicity choice (§19): one envelope shape for both hops,
one validation path, readable with `redis-cli SUBSCRIBE document:<id>`. Raw
binary Pub/Sub would save about a quarter of the bytes at the cost of a second
format.

## Pub/Sub loses messages, so convergence must not depend on it

Redis Pub/Sub is fire-and-forget: a message published while a subscriber is
disconnected is gone. On a healthy connection it does not drop messages — a slow
subscriber is _disconnected_ instead — so every loss coincides with a
disconnect. Two mechanisms close the gap:

1. **Handshake on (re)subscribe.** When an instance opens a document, and again
   whenever its Redis connection recovers, it broadcasts its state vector (a
   "hello"). Each peer replies with exactly the updates it has that the newcomer
   lacks, and asks for the reverse. It is the same step-1/step-2 exchange browsers
   use with the server. Targeted replies are never answered with another step 1,
   so the exchange cannot loop.

   This also covers a subtle case: an instance that opens a document while
   another instance has _unsaved_ edits in memory. PostgreSQL is up to 10 s
   behind; the hello fetches the difference from the peer directly. (Tested with
   saves deliberately frozen.)

2. **Merge-on-save.** Saving locks the row (`SELECT … FOR UPDATE`), merges the
   stored state with this instance's state in a temporary `Y.Doc`, and writes the
   union. Two instances that diverged can therefore never overwrite each other
   in PostgreSQL, and every instance persists what it holds, so the crash of the
   instance where an edit was typed does not lose it either.

## When Redis is unavailable (§43)

Exact behaviour, verified by stopping the Redis container mid-session:

| Aspect                           | Behaviour while Redis is down                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Editing on an existing socket    | Continues. Users on the **same** instance still see each other live.                                                              |
| Users on **different** instances | Stop seeing each other's edits and cursors. Their copies diverge, which a CRDT merges safely later.                               |
| What the user sees               | `Degraded: other servers out of sync` in the editor status bar (`cluster` message).                                               |
| Persistence                      | Continues, merge-on-save. PostgreSQL ends up with the union of both sides. Nothing is overwritten.                                |
| New WebSocket connections        | Fail: tickets are stored in Redis. Clients keep retrying with backoff.                                                            |
| Login / token refresh            | Fail: refresh sessions are in Redis. Existing access tokens keep working until they expire (15 min).                              |
| `/readyz`                        | `503 degraded`, so a load balancer stops sending _new_ traffic to the instance.                                                   |
| When Redis returns               | Each instance re-subscribes, sends a hello, and the diverged copies reconcile **without clients reconnecting**. The badge clears. |

Synchronisation is therefore not blocked during an outage. Blocking would only
be necessary if divergence could corrupt the document, and with a CRDT plus
merge-on-save it cannot: the worst case is that users on different instances
temporarily do not see each other, and are told so.

Not handled: if Redis stays down long enough for access tokens to expire, users
cannot refresh and must wait for Redis to log in again. Redis is a hard
dependency for authentication; it is not one for document integrity.

## Running two instances locally

Until Phase 12 adds Nginx, start the instances on two ports and connect clients
to each directly. `PORT` from the environment wins over `.env`.

```bash
# Git Bash / macOS / Linux
PORT=4000 npm run start --workspace @collab/backend
PORT=4001 npm run start --workspace @collab/backend
```

```powershell
# PowerShell
$env:PORT=4001; npm run start --workspace @collab/backend
```

Each socket's log line names the instance that served it
(`instance: "<host>:<port>"`). A demo that cannot show which instance served
which socket proves nothing.

## Evidence

- `backend/tests/cluster.test.js` runs two complete instances (WebSocket server
  - hub) in one process over an in-memory bus that can simulate an outage:
    cross-instance editing and presence, a newcomer instance catching up while
    PostgreSQL lags, outage then recovery, merge-on-save, a forged cross-instance
    presence removal, and garbage on the channel. Each Phase 8 mechanism was
    mutation-checked: removing it makes exactly its test fail.
- End to end against two real processes, real Redis and PostgreSQL: concurrent
  edits on different instances converge, presence crosses instances, stopping
  Redis produces the degraded state, edits made during the outage reconcile
  after `docker start`, and PostgreSQL holds every edit from both sides.
