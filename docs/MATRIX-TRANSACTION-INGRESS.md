# Matrix transaction ingress implementation

`src/matrix/transaction-server.ts` creates an appservice HTTP server with bearer-token
authentication, bounded JSON input and body size, request timeouts, and generic errors. The
integration test binds it to an ephemeral loopback port. Production startup must bind it to loopback
behind `bbctl proxy`; there is no production launcher yet.

A successful HTTP response means the full transaction has committed to the SQLCipher inbox with WAL
and FULL synchronization. It does not mean delivery to Threema. A repeated transaction ID with the
same canonical JSON is accepted; a different payload for that ID is rejected. Invalid requests are
rejected before storage, and storage errors return a retryable failure without internal details.

`transaction-worker.ts` serializes processing. It applies the decoder and atomically saves all
resulting decrypted events with completion of the source transaction. Event IDs deduplicate repeated
events across transactions. A decode or commit failure leaves the source pending and publishes no
partial events. Later transactions can still supply missing keys; subsequent batches prioritize
transactions with fewer attempts. Failure reports omit decoder exception details.

The worker's decoder must never perform outward bridge message sends. The next stage must use the
handoff's durable outbox and correlation rules. Native crypto persistence and the SQLCipher inbox
are separate stores: crypto updates may be replayed after a crash before the inbox commit. Full
crash testing of that boundary is still required. HTTP/body validation does not yet validate every
crypto extension field. Completed deduplication records currently have no pruning policy.

Verification with Node 24 and prepared upstream dependencies:

```sh
pnpm run test:inbox
pnpm run test:appservice-http
pnpm run probe:matrix-devices
pnpm run typecheck
```

Tests cover SIGKILL after durable acceptance, restart, wrong-key rejection, duplicate/conflicting
transactions, event-level deduplication, atomic rollback, concurrent worker drains, missing-key
ordering, authentication, malformed/oversized/chunked input, and storage failure responses. The
native two-device test routes its crypto transactions through the durable worker and inbox.

Remaining integration includes profile/process locking, startup recovery and retry scheduling, full
extension validation/control events, framework lifecycle, persistent appservice login, portal
selection, outbound event processing, and real Beeper compatibility. Gate 0D remains open.

`transaction-pump.ts` now performs immediate startup recovery, bounded periodic batches and delayed
retry after a decoder failure. It exposes metadata-only states and drains the active decoder before
shutdown. The startup test reopens pending storage, injects a temporary decoder outage, confirms
retry, and verifies shutdown waits for the active transaction. The final launcher still needs to own
process locking, SDK initialization, loopback binding and store shutdown in that order.
