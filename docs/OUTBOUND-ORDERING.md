# Outbound source ordering

Text and reaction ingress use the durable inbox transaction arrival sequence. Event insertion
sequence only breaks ties within a transaction; delayed decryption cannot promote a later
transaction ahead of an older one. An older undecoded transaction blocks all outbound chats
because its destinations are not known yet.

Within one owner/room, an earlier message, reaction or redaction must be classified before
later work enters either queue. Dispatch additionally requires earlier text to be SENT/ACKED
and every earlier reaction part to be SENT/REJECTED. Durable rejection settles an action even
when its explanatory Matrix notice still needs retrying. Plaintext message/reaction events,
state events and other senders do not become outbound dependencies.

Both runtime send paths check ordering before and after fresh asynchronous room authorization.
Recovery and explanatory notices retain their own authorization checks without the dispatch
ordering barrier, so they can resolve uncertain predecessors. An uncertain operation blocks
later sends in that chat across restart; other decoded chats remain eligible. A reaction to a
known but later unsent text event is rejected instead of creating a dependency cycle.

Validation: `pnpm run test:source-order`, `pnpm run test:reaction-runtime`,
`pnpm run test:reaction-ingress`, and `pnpm run test:matrix-outbox` exercise encrypted local
stores with synthetic events. No live account operation is part of these checks.

Limits: predecessor lookup currently scans retained events for the owner/room. Large-history
performance remains to be measured and improved. Text ingress repairs legacy PREPARED request ordering within each profile/chat, using source
positions from the inbox. Sequence changes commit atomically; request IDs, bodies, retry
deadlines and attempted-send states are preserved. A group with missing source provenance
is left unchanged. This repair runs after ingestion so newly decoded earlier work can move
ahead of already queued later work. Reaction ingress similarly repairs the wholly unattempted tail of each chat, moving operation
keys and all multipart rows in one transaction with deferred foreign-key verification. Any
attempted prefix remains fixed because it defines historical reference effects. A legacy
inversion spanning that prefix still fails closed and needs explicit reconciliation; the
repair does not pretend it can undo an action already attempted. The ordering
integration must be extended when media, edits, deletes and receipt send paths are implemented.

Recovery and rejection-notice scans use `(operation sequence, part)` cursors. Each bounded
batch advances past mismatches and failures, then wraps after reaching the end. A failed
first notice cannot starve subsequent parts of the same message. Cursors are process-local:
restart begins at the first outstanding row, while durable part states and stable notice
transaction IDs preserve recovery and retry behavior. Attempted operations are excluded from
queue reordering, so their cursor positions do not move during normal repair. Tests in
`entry.reaction-recovery.ts` and `entry.reaction-failure-notices.ts` cover one-item batches,
authorization failure, mismatched state, wraparound, and stable notice retries.
