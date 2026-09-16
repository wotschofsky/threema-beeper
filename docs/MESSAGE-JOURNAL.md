# Durable normalized messages

`message-codec.ts` stores a version-1 JSON envelope with deterministic object-key ordering. It
encodes known Date fields as epoch milliseconds and bigint ordinals as canonical decimal strings.
Decoding handles only those known fields, then runs the full normalized-message validator. It does
not use a generic object reviver or infer types from user text. Unsupported versions, malformed
timestamps, noncanonical ordinals and unknown message fields fail validation.

`MessageJournal` stores the latest normalized record and a pending change in one SQLCipher
transaction. It uses WAL with FULL synchronization. The primary key includes profile identity,
chat ID and message ID; SHA-256 of the deterministic encoding detects identical replay. A changed
record appends a new durable change, preserving edit order. Acknowledgement removes exactly one
pending change for that profile, while the latest-state row remains for reconciliation. Sequence
numbers cross the SQLite boundary as strings so long-running journals do not lose integer precision.

The caller supplies a 32-byte database key and must use a private directory. This component does not
derive the deployment key, deliver Matrix events, or coordinate event mappings. Acknowledgement
must occur only after downstream work is durably recorded. Production synchronization still needs
to connect the model watcher/history pages to this journal and the journal to Matrix delivery.
Source ordering, retention/compaction, full reconciliation epochs and backpressure remain pending.

`pnpm run test:message-journal` verifies exact Date/bigint round trips, deterministic encoding,
invalid encodings, duplicate replay, edit retention and profile isolation. Its child process writes
a record then dies by SIGKILL; reopening recovers that pending record from SQLCipher. The test also
checks wrong-key rejection and that database/WAL files do not contain the synthetic message text.
No real accounts or messages were used.

The headless session now has `watchMessages(chatId, consume, onReset)`. It attaches every inner
message store before history enumeration, suppresses only existing models' initial callbacks, and
normalizes subsequent changes immediately. Newly added models emit their initial value. An ordered
async queue awaits each consumer so storage acknowledgement can provide backpressure. More than
2,048 outstanding updates invalidates the stream rather than silently dropping updates. A physical
model removal, collection clear, normalization failure or consumer failure also requests reset;
deleted-message models themselves remain ordinary upserts. Stop detaches listeners and waits for
an active consumer.

`pnpm run test:live-message-journal` uses real upstream store implementations and SQLCipher to
verify edit/reaction commits in order, initial-value handling, failure/reset, removal and overflow.
These are synthetic model changes. The watcher API is worker-local; IPC subscription ownership,
whole-profile collection resets, snapshot buffering/replay and production ingestion still need
integration. The journal must not deliver a partially reconciled stream as if synchronization had
completed.

`BackendController.watchMessages(chatId, consume, onReset)` now owns a dedicated MessagePort for
each subscription. The worker validates each normalized update and waits for acknowledgement;
the parent validates it again and acknowledges only after `consume` resolves. A 30-second missing
acknowledgement, malformed packet, wrong sequence, wrong chat, consumer failure or closed worker
invalidates the stream. At most one update per port is in flight. Unsubscribe detaches the upstream
watcher, closes the port and waits for any active parent consumer. The worker caps subscriptions at
1,024 and cleans up failed attachment ports. No caller should treat reset as successful completion.

`pnpm run test:message-subscription` checks the protocol using real MessageChannels, including delayed
consumer commit, failures, malformed/wrong-chat records and missing acknowledgements. Worker tests
verify subscription attempts before profile open fail and release their ports. Whole-profile
snapshot/live coordination, epoch gating and production ingestion remain pending.

Per-chat snapshot/live coordination is now implemented in `reconcile-chat.ts`. It attaches the
worker subscription first, writes acknowledged live events into encrypted staging, then enumerates
history into a separate snapshot phase. A single SQLCipher transaction publishes snapshot records
followed by observed live events and removes the staging token. It switches to direct live upserts
without an asynchronous gap. A reset, signal or failed enumeration aborts staging and stops the
subscription. This prevents a delayed snapshot from permanently replacing a newer observed edit.

Journal schema 2 adds durable reconciliation tokens and staging rows, capped at 128 MiB per chat
attempt. Only one attempt per profile/chat may exist. Incomplete attempts are invisible to pending
delivery and survive restart until discarded after exclusive profile ownership is acquired. Commit
reads small staging batches inside its transaction; it does not materialize the whole staged stream.
Tests cover snapshot/live ordering, hidden incomplete work, reset, reopen and explicit discard.

This is per-chat reconciliation. Whole-profile discovery, metadata/collection reset handling,
sync-epoch completion signals, automatic restart/backoff and gating outbound sends across all chats
still require the service coordinator. The 128 MiB cap and synchronous commit performance need the
large-profile acceptance benchmark. No production launcher starts message ingestion yet.

`BackendController.watchTopology(onReset)` now exposes profile invalidation through a dedicated
port. The headless adapter watches conversation collection deltas, then outer and inner contact
and group stores. Existing initial metadata does not invalidate; later additions, removals,
collection clears or metadata updates do. The first invalidation detaches all listeners. Message
changes themselves remain on per-chat message subscriptions. The coordinator must attach this
profile listener before enumerating chats and restart the epoch when it resets or its port closes.
Stopping it intentionally does not report failure. Tests use real upstream stores and MessagePorts.
Full service-level epoch orchestration and retry/backoff remain pending.

Journal schema 3 adds the latest profile metadata snapshot and its completed epoch ID. The metadata
codec uses an explicit versioned envelope and decimal group IDs, restoring bigint only in that
known field before validation. `commitProfile` verifies that reconciliation tokens cover exactly
the metadata's chats, then publishes all staged messages and metadata in one transaction. The
coordinator calls it after all histories complete. Metadata remains pending until acknowledged by
its exact epoch; a stale acknowledgement cannot clear a newer snapshot. The latest snapshot remains
readable after acknowledgement for portal reconciliation.

`pnpm run test:profile-metadata` verifies group-ID precision, reopening, pending acknowledgement and
publication rollback using a synthetic SQL trigger failure. Failure at metadata insertion rolls
back previously staged message publication as well. The snapshot contains no avatars yet, and
Matrix consumers/detailed synchronization event records still require implementation.
