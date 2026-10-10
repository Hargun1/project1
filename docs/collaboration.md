# Real-time collaboration

> **Implemented: Phases 5 (WebSockets), 6 (Yjs), 7 (presence) and 8 (several
> backend instances via Redis — see [scaling.md](scaling.md)) and 9 (revision
> history and restore).**
> Why a CRDT at all is argued in [architecture.md](architecture.md).

## The pieces

```
 Browser                                         Backend instance
 ───────                                         ────────────────
 Monaco model                                    collaboration.service.js
    ⇅  y-monaco binding                            one Y.Doc per *open* document
 Y.Text "content"                                  ├─ loads documents.yjs_state on first join
    ⇅                                              ├─ applies client updates (role-checked)
 Y.Doc ── collab-provider.js ── ws-client.js ══════╪═ forwards each update to the other sockets
          (sync protocol)       (ticket, backoff)  └─ debounced save → documents.yjs_state
```

| Module                                          | Owns                                                          |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `frontend/src/websocket/ws-client.js`           | Socket, ticket, keepalive, reconnect backoff. Knows no Yjs.   |
| `frontend/src/collaboration/collab-provider.js` | The sync protocol and the save-status calculation.            |
| `frontend/src/pages/EditorPage.jsx`             | Creates the Y.Doc and the y-monaco binding. No text in React. |
| `backend/src/websocket/connection.js`           | Ticket → authorisation → session → message dispatch.          |
| `backend/src/services/collaboration.service.js` | In-memory Y.Docs, debounced persistence, eviction.            |
| `shared/src/ws-messages.js`                     | The message vocabulary both sides import.                     |

## Decision: hand-rolled sync over our own socket, not `y-websocket`

The spec (§18) asks for this to be stated explicitly.

**Used from libraries:** `yjs` (the CRDT) and `y-monaco` (the editor binding).
Binding Monaco's edit events to `Y.Text` correctly — multi-cursor edits,
selection preservation, undo — is fiddly and unrelated to what this project is
demonstrating.

**Hand-rolled:** the provider and the server. `y-websocket` would have worked
for a single instance, but:

- Its server authenticates nothing. This project already had single-use tickets,
  a role check on every connection, and typed error messages (Phase 5); bolting
  those onto y-websocket means forking or wrapping it anyway.
- A VIEWER's edits must be refused **on the server**. That is a dispatch decision
  per message, which is a natural `switch` in our code and an awkward hook in a
  library.
- It speaks lib0 binary framing. Our protocol is JSON validated by one Zod union,
  readable in DevTools, and the same envelope crosses Redis between instances.
- The whole protocol is ~100 lines on each side. Being able to explain every line
  of it is the point of the project.

The cost: we own the bugs. The protocol is therefore pinned by tests that drive
the real server with real Yjs clients (`backend/tests/collaboration.test.js`).

## The sync protocol

One socket = one document, fixed by the ticket. Messages carry no `documentId`,
so a client can never redirect a payload to another document after it has been
authorised.

```
server → client  joined       { documentId, userId, userName, role }
client → server  sync-step1   { stateVector }   "this is what I have"
server → client  sync-step2   { update }        everything the client lacks
server → client  sync-step1   { stateVector }   "this is what I have"
client → server  sync-step2   { update }        everything the server lacks
both ways        update       { update }        live incremental edits
server → client  saved        { stateVector }   this state is now in PostgreSQL
server → client  save-failed  {}                a save failed; edits are still in memory
server → client  error        { code, message } a message was refused; socket stays open
```

A **state vector** is a map `clientID → clock`: for every client that has ever
edited the document, how many operations of theirs this replica has seen.
`Y.encodeStateAsUpdate(doc, theirStateVector)` produces exactly the operations
the other side is missing. That is why sync costs bytes proportional to _what
changed_, not to document size, and why the same handshake handles first load,
late joiners and reconnection.

## Reconnection (§21)

There is no special reconnect code. When the socket drops:

1. `ws-client` shows "Reconnecting…" and retries with exponential backoff plus
   jitter (so a restarted server is not hit by every client at once).
2. Each attempt gets a fresh access token if needed, then a fresh ticket.
3. Local edits keep landing in the `Y.Doc`; the sends are simply dropped.
4. On `joined`, the normal handshake runs. The server's `sync-step1` makes the
   client send everything typed while offline; the client's `sync-step1` makes
   the server send everything others typed meanwhile.

Retries stop only on close codes that cannot succeed later (`4001` bad ticket,
`4003` not a member, `4004` no such document) or a 401/403/404 when minting a
ticket. `4009 DOCUMENT_UNAVAILABLE` (database down) and `4008 SERVER_SHUTDOWN`
are retried.

## Persistence

### Decision: binary CRDT state, never text

`documents.yjs_state` (`BYTEA`) holds `Y.encodeStateAsUpdate(doc)`. It is the
document's **current** state and is what the server loads when a document is
opened.

Storing text and re-creating the `Y.Doc` from it on load looks equivalent and is
not. Inserting text into a fresh `Y.Doc` gives every character a _new_ CRDT
identity. A client still holding the old state — a tab that stayed open across a
server restart — would then merge two unrelated copies and the document would
appear twice. Binary state keeps identities stable, so a reloaded server and a
reconnecting client agree on what each character _is_.

The Phase 4 design (`PUT /api/documents/:id/content` with the whole text) was
removed for the same reason, and because two clients saving whole-document
strings is last-writer-wins: it silently discards the other person's edits.

**Current state vs history.** `yjs_state` is overwritten. Append-only revision
history is a separate table, `document_revisions` (see
[Revision history](#revision-history-and-restore-25) below). Keeping them apart
means loading a document never has to search history for "the latest row".

### Debounced saving (§24)

Edits never write to PostgreSQL directly. The session saves after
`DOC_SNAPSHOT_DEBOUNCE_MS` (default 2 s) of quiet, and at least every
`DOC_SNAPSHOT_MAX_WAIT_MS` (10 s) during continuous typing — a pure debounce
would never fire for someone who never pauses. Saves for one document never
overlap: a save requested mid-flight is queued, so an older state cannot land on
top of a newer one.

When the last connection leaves, the session saves immediately and is evicted
from memory **only after that save succeeds**. If PostgreSQL is down, the
session stays in memory and retries every 5 s rather than dropping the edits.
On graceful shutdown (`SIGTERM`), sockets close first, then every session is
flushed, then the database pool closes.

**Bounded loss window, stated honestly:** if the process is killed outright, the
server loses up to ~10 s of edits. Any client still connected (or reconnecting)
holds those edits in its own `Y.Doc` and re-uploads them via `sync-step2`, so in
practice they come back the moment it reconnects.

### Save status (§44)

The badge shows `Saved`, `Saving…`, `Save failed` or `Offline`. "Saved" is not a
guess based on timing: the server's `saved` message carries the state vector it
persisted, and the client shows `Saved` only when that vector covers the
client's _own_ latest clock. A `saved` for an older state can never hide a newer
unsaved edit.

## Revision history and restore (§25)

A revision is an append-only binary snapshot (`Y.encodeStateAsUpdate`) in
`document_revisions`, with a number, an author and a `kind`:

| Kind      | Created when                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTO`    | A save happens, the text changed since the latest revision, and `DOC_REVISION_INTERVAL_MS` (5 min) has passed. Also when everyone leaves an instance. |
| `MANUAL`  | An OWNER or EDITOR clicks **Save version**. If nothing changed, the existing latest revision is returned (`200`) instead of a duplicate.              |
| `RESTORE` | An OWNER restores an older revision. `restored_from_number` records which one.                                                                        |

"Changed" compares _text_, not bytes: typing a character and deleting it changes
the CRDT state but not the content, and is not worth a revision.

**Created under the same row lock as the save.** Revisions are written inside
`withLockedDocumentState`, the same `SELECT … FOR UPDATE` transaction that
merges the live state. With several backend instances, two of them saving at the
same moment are serialised: the second sees the revision the first created, so
revision numbers cannot collide and two instances cannot both decide a
checkpoint is due. Verified on real PostgreSQL: four parallel "Save version"
requests split across two instances produce exactly one new revision.

**Up to date before acting.** "Save version" or "Restore" can land on an
instance where nobody has the document open, and PostgreSQL can be up to 10 s
behind another instance's memory. Opening a session therefore does not finish
until every peer that has the document open has answered its hello with what it
has (Redis `PUBLISH` returns how many subscribers received the message, so the
instance knows how many answers to wait for, bounded by 1 s). Tested by saving a
version on one instance of an edit that existed only in another instance's
memory.

### Restoring: why the spec's mechanic does not work, and what does

The specification describes restore as: load the old snapshot into a fresh
`Y.Doc` and apply it to the live document as an update. **In a CRDT that is a
no-op.** State only grows; every operation in an old snapshot is already part of
the live document's history, including the deletions made since. Applying it
changes nothing. `backend/tests/revision.logic.test.js` demonstrates this.

What the implementation does instead (`restoreRevision` in the hub):

1. Load the target snapshot into a fresh `Y.Doc` and read its text.
2. Compute the difference between the live text and that text (common prefix
   and suffix, lib0's `simpleDiffString`) and apply it to the live `Y.Text` as
   one transaction: one delete, one insert.
3. That transaction is an ordinary update. It goes to every connected client on
   this instance and, via Redis, on every other instance, so nobody's editor is
   reloaded; text outside the changed range keeps its identity, along with
   anyone's cursor there.
4. Save immediately and record a new `RESTORE` revision. History is never edited
   or truncated: restoring revision 2 of 3 produces revision 4.

If someone types _while_ a restore happens, their edit is concurrent with the
restore and merges like any other concurrent edit.

### Who can do what

| Action         | OWNER | EDITOR | VIEWER |
| -------------- | :---: | :----: | :----: |
| Browse history |   ✓   |   ✓    |   ✓    |
| Save version   |   ✓   |   ✓    |        |
| Restore        |   ✓   |        |        |

Enforced in `revision.service.js` on every request. The UI hiding a button is a
courtesy. The binary snapshot never leaves the server: a revision is returned as
text.

## Authorisation on the socket

Checked at two points, both on the server:

- **On connect:** the ticket proves who the user was when it was minted; the
  server then re-reads membership and role from PostgreSQL before joining.
- **Per message:** `update` and `sync-step2` from a `VIEWER` are refused
  (`error: FORBIDDEN`). The read-only Monaco editor is a UX affordance; a viewer
  who opens a socket by hand is still refused. Tested.

- **Over time (Phase 10):** a role change, removal or deletion makes every
  instance re-check the affected sockets against PostgreSQL. A downgraded user
  receives `{ type: 'role', role }` and their next edit is refused; a removed
  user's socket is closed with `4003`, and everyone on a deleted document gets
  `4004`. A 60-second periodic re-check is the safety net if the Redis
  announcement is lost. See [security.md](security.md).

## Presence (Phase 7, §20)

Who is here, and where their cursor is, travels as Yjs **awareness** state
(`y-protocols/awareness`) in `awareness` messages, next to the document sync.

```
{ user: { id, name, color }, selection?: { anchor, head } }
                                           └ Y.RelativePosition JSON, written by y-monaco
```

**Ephemeral by design.** Awareness is never written to PostgreSQL. A client
renews its state every 15 s; an entry not renewed for 30 s is dropped by
everyone. Presence that outlived its user would be a lie.

**Relative positions, not offsets.** A cursor is stored as a CRDT position
("just after character X"), not as "offset 120". When someone types above your
cursor, offset 120 points at a different character; a relative position still
points at the same one. y-monaco converts to and from Monaco positions.

**Why the server keeps an Awareness per document,** even though presence is
never persisted (`backend/src/services/presence.service.js`):

1. _Late joiners._ A new client receives everyone's current presence in the
   join handshake, instead of seeing nobody until each person moves their cursor.
2. _Fast departure._ The server records which awareness entry each connection
   owns. When a socket closes, it removes that entry at once and tells the
   others: tested at ~10 ms end to end, against the 30 s timeout otherwise.
3. _Identity._ Awareness state is JSON written by one browser and rendered in
   others. The server decodes every update before applying it, validates it
   with Zod (exact shape, `#rrggbb` colour, relative-position structure), and
   requires `user.id` and `user.name` to equal the authenticated socket's. A
   client therefore cannot label its cursor with someone else's name, nor
   remove or overwrite another user's entry. Viewers may publish presence:
   being seen reading is not editing.

**Removal clocks.** Awareness accepts an update only if its clock is newer than
the last one seen. Removing a _remote_ entry keeps its clock (y-protocols bumps
the clock only when a client removes itself), so a client that reconnects is
seen again immediately. A regression test reconnects a client with its
existing awareness and asserts that the others see it again within a second.

**Rendering.** y-monaco draws remote selections as Monaco decorations; per-user
colours and name labels come from CSS generated at runtime
(`frontend/src/collaboration/cursor-styles.js`). The name is placed inside a CSS
string, so every character outside `[A-Za-z0-9 ]` is hex-escaped, colours must
match `#rrggbb`, and client ids must be integers. Without that, a display name
like `"}body{display:none}` would be CSS injection. That check runs in the
browser as well as on the server, and is unit-tested.

**React stays out of the hot path.** `usePresence` updates React state only
when the _set_ of people changes, never on cursor movement, so a collaborator
moving their caret does not re-render the editor page (§30).

## Wire format

Yjs updates are `Uint8Array`s; messages are JSON, so binary fields are base64
(`shared/src/encoding.js`). That is ~33% larger than raw binary frames. It is a
deliberate trade: one message format, one validation path, readable in
DevTools, and the same envelope is published to Redis between instances
([scaling.md](scaling.md)).
If bandwidth ever mattered, switching the WebSocket to binary frames would not
touch the CRDT logic.

## Limits (Phase 11)

- **Document size:** an update that would take the document over
  `MAX_DOCUMENT_SIZE_BYTES` is refused before it is applied (`error:
DOCUMENT_TOO_LARGE`); the client discards its local copy and re-syncs.
- **Message rate:** a socket that exceeds its token bucket (40/s sustained,
  burst 200) is closed with `4029`; the client reconnects and re-syncs through
  state vectors, so nothing is lost. Details in [security.md](security.md).

With several backend instances, each holds its own copy of an open document and
they are kept in sync over Redis; how, and what happens when Redis is down, is in
[scaling.md](scaling.md).
