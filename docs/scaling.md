# Scaling

> **Not implemented yet — Phases 8 and 14.** Design notes only.

## Why the design scales at all

Because merging is a CRDT property rather than a server responsibility, a backend
instance never has to be the single ordering authority for a document. Instances
are therefore interchangeable, and adding one is a capacity change rather than an
architecture change.

## Planned approach

- **Stateless HTTP.** No server-side session store; identity comes from a
  verified token on each request, so any instance can serve any request.
- **Sticky-free WebSockets.** A socket lands on whichever instance the load
  balancer picks. That instance loads the document's `Y.Doc` into memory and
  subscribes to `doc:<id>` on Redis; updates from other instances arrive over
  Pub/Sub. No shared memory, no cross-instance RPC.
- **Redis as transport, never storage.** Losing Redis costs live fan-out, not
  document content.
- **Bounded memory.** Instances evict idle `Y.Doc`s after a final snapshot, so
  memory tracks _concurrently open_ documents rather than total documents.

## Planned proof

Run two backend instances behind Nginx, connect two browsers, and confirm an edit
in one appears in the other after verifying (from logs) that the two sockets are
on different instances. A demo that cannot show which instance served which
socket does not prove anything.

Phase 14 covers deployment: ECS/EC2 behind an ALB with WebSocket support, RDS for
PostgreSQL, ElastiCache for Redis.
