# Real-time collaboration

> **Not implemented yet — Phases 4 to 9.** This file records the intended design.
> The reasoning behind choosing a CRDT is in [architecture.md](architecture.md).

## Planned design

**Editing (Phases 4, 6).** Monaco is bound to a `Y.Text` inside a `Y.Doc` via
`y-monaco`. A local edit mutates the `Y.Text`; the `Y.Doc` emits a small binary
update; the client sends that update. Never the whole document — a
whole-document write is last-writer-wins and would defeat the merge.

**Transport (Phase 5).** One WebSocket per open document, authenticated with a
single-use ticket:

1. The client calls an authenticated HTTP endpoint to mint a ticket.
2. The ticket is stored in Redis with a ~30 s TTL, bound to user + document.
3. The client connects with `?ticket=…`.
4. The server consumes the ticket atomically, so a replay fails.

Every inbound message is validated against a discriminated union defined in
`@collab/shared`, so client and server cannot disagree about the wire format.

**Fan-out (Phase 8).** Each instance keeps the `Y.Doc` for open documents in
memory, broadcasts updates to its own sockets, and publishes to `doc:<id>` on
Redis so other instances relay to theirs. Redis is transport only.

**Presence (Phase 7).** Cursor position, selection and user colour travel through
Yjs Awareness, which is ephemeral by design: presence is never persisted, and a
disconnected client's cursor disappears on its own.

**Persistence (Phase 9).** A debounced snapshot (`DOC_SNAPSHOT_DEBOUNCE_MS`,
default 2 s idle) writes `Y.encodeStateAsUpdate()` to `document_revisions` as
binary. Documents are capped by `MAX_DOCUMENT_SIZE_BYTES`. The bounded loss
window this creates is stated explicitly in
[architecture.md](architecture.md#why-postgresql-stores-binary-snapshots).
