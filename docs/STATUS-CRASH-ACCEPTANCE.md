# Sent-status recovery after process termination

`tests/entry.status-crash.ts` tests a completed outbound text, file, image, audio
or video whose encrypted Matrix status still needs delivery. Each case starts
with a committed `SENT` outbox row and an existing portal/message mapping.

The parent kills a child process with SIGKILL and waits for its exit at each of
these checkpoints:

1. Before status processing.
2. After encrypted operation persistence, before the Matrix PUT.
3. After simulated Matrix acceptance, before the response returns.
4. After encrypted result persistence, before status bookkeeping completes.
5. After status bookkeeping completes.

Recovery replays the original outbox request and runs both the text worker and
media dispatcher. Neither may send again or prepare an already completed
attachment. It then applies the status twice using the real `StatusDelivery`,
`EncryptedSender`, SQLCipher portal store and native Matrix `OlmMachine`.

The simulated Matrix server persists the accepted transaction path and encrypted
body separately from the bridge databases. A retry must use identical bytes and
the same transaction ID. Native encryption must run only once. After reopening
the native crypto store, the accepted event must decrypt to the expected `sent`
status, timestamp and original-event reference. The lost-response case makes two
PUT attempts for the same accepted event; all other cases make one.

This exercises 25 combinations. It does not create a real Threema or Matrix
connection. The outbound send result is seeded rather than performing native
uploads. Image projection and audio/video file-fallback records exercise those
durable queue types; codec preparation is outside this test. Native Megolm is
real, but room-key distribution to other devices and homeserver idempotency are
not live-tested here. Journal acknowledgement, pending UI behavior, receipts and
the full native send/upload crash matrix remain separate acceptance work.

The Linux runs use the existing migration images, networking disabled, a read-only
root, dropped capabilities and private non-executable scratch storage. Only the
new test fixture is mounted; production modules and native dependencies come
from the image. This fixture is staged for future builds, but is absent from the
already exported migration archives. See [verification evidence](STATUS-CRASH-VERIFICATION.json).
