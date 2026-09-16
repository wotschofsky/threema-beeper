# Delivery from the encrypted journal

`JournalDelivery` drains committed metadata and message changes into a `JournalSink`. It checks
profile readiness before delivery, applies pending metadata first, and checks again before every
message. If a newer metadata epoch appears during a call, later messages wait for its application.
Concurrent drains share one promise. Work is acknowledged only after the sink resolves; failures
remain queued and the background loop retries with capped backoff. Stop waits for the active sink
call and prevents starting the next one.

Journal schema 4 stores a random durable database instance ID. Each message operation ID combines
that instance with its durable change sequence. Retries after restart reuse the same ID, while a
later edit back to earlier text gets a distinct ID. Recreating a journal generates a new instance,
preventing its new sequence numbers from colliding with the old journal. Metadata operation IDs
use the persisted completed epoch. These are application idempotency keys, not proof of exactly-once
network effects.

A Matrix sink must enforce encrypted portals, use operation IDs for retry-safe requests and persist
event mappings before resolving. The concrete Matrix sink, portal reconciliation and message-content
rendering are still pending. No live messages were sent by this implementation or its tests.

`pnpm run test:journal-delivery` verifies readiness gating, metadata-first order, concurrent drain
serialization, retained failures, stable retry IDs and distinct edit-cycle IDs. Journal tests verify
operation ID persistence across reopen. Tests use a real SQLCipher journal and synthetic sinks.
