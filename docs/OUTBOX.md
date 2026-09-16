# Durable outbound requests

The initial text outbox uses a separate schema-1 SQLCipher database with WAL and synchronous FULL.
Its private directory belongs to one exclusively owned profile runtime. OutboxStore.prepare stores
an externally supplied UUIDv7 request ID, profile, Matrix transaction/event/room/sender, canonical
chat, text/reply content, fingerprint and creation time. Explicit field projection excludes unknown
input properties. Event replay is unique by profile/event, including delivery under another Matrix
transaction ID. Conflicting content or request-ID reuse is rejected.

OutboxWorker leaves PREPARED rows untouched until its readiness callback is true. It atomically
claims a row as DISPATCHING before calling the sender. The sender must await recordIds through the
provided callback before creating local messages. All part IDs are recorded in one transaction,
ordered and unique, without converting them through JavaScript numbers. A result must exactly match
the saved IDs to enter SENT. Returning IDs without invoking the callback is an uncertain failure.

On startup, before dispatch starts, call recoverInterrupted: DISPATCHING becomes OUTCOME_UNKNOWN.
A caught dispatch error likewise becomes OUTCOME_UNKNOWN. Neither state is selected for automatic
resend. Even a crash between claim and the actual call remains uncertain when there is no durable
proof that the core did not run. Explicit operator resolution and proven-before-side-effect retries
are not implemented yet.

The parts table is a durable reverse association from profile/message ID to the original request and
Matrix event. A verified outbound canonical echo can call observe with its profile, chat and ID.
Wrong-chat echoes fail; other profiles cannot match. Each part is marked observed, and ACKED requires
all parts. Echoes arriving before the send result are supported: completion never downgrades ACKED.
Repeated echoes are idempotent. The caller must verify direction/identity and apply this association
to the Matrix portal mapping to suppress a duplicate local-echo room event. That integration remains
pending; observing a row alone does not update PortalStore.

Implemented checks cover encrypted-store reopen, Matrix replay/content conflicts, reconciliation
readiness, uncertain restart with/without IDs, multiple parts, wrong profile/chat, early/repeated
local echoes, overlapping worker calls and a sender that omits the persistence hook. The restart
checks close/reopen real SQLCipher; hard-kill injection and real backend transport are still pending.

The store/worker are not yet connected to appservice transaction ingestion, the backend worker send
command, canonical journal reconciliation or service startup. UUIDv7 generation, limits/permissions
against upstream, visible Matrix status/management notices, durable retry policy for known pre-send
failures and media/edit/delete commands remain unfinished. No live send has been performed.


## Backend text adapter and Desktop callback transport

The headless session now exposes sendText backed by sendNodeText. It checks the active identity,
canonical chat/reply syntax, nonempty text against the actual compiled Desktop byte limit, and group
membership; resolves the existing conversation/view-model controller; and invokes sendMessageWithIds.
ID conversion uses upstream hex little-endian helpers throughout, including maximum u64 values.
The pre-send hook is now a proxied object with a record method, not a bare callback function.

Desktop's Local<RemoteProxy<T>> inference misidentifies the recorder as PropertiesMarked because
its marker constants are widened to symbol. A narrow documented type correction at the adapter call
preserves the real PROXY_HANDLER object. A built-runtime integration test exercises real Desktop
endpoint serialization, the real patched send controller, the real SQLCipher outbox/worker and a
synthetic conversation insertion. At insertion it verifies that canonical IDs are already committed.
It also checks reply preservation, wrong identity/oversized text rejection, and a persistence error
propagating across the proxy without insertion. No live account or network send was used.

The callback transport inside Desktop is verified. The separate parent/backend-worker allocation
acknowledgement protocol, send command, appservice ingress, echo mapping and live delivery remain
pending. This does not complete Gate 0C or the full outbound path.


## Main-process allocation acknowledgement

BackendController.sendText now transfers a dedicated MessagePort with the projected text request.
The backend worker validates the request and invokes session.sendText with a SendAllocation barrier.
When Desktop allocates IDs, the barrier sends only canonical IDs to the parent and waits up to 30
seconds. The parent validates the ID array and awaits the outbox persistence callback before sending
allocation-committed. Failure closes the port without exposing raw database diagnostics. Disconnect,
timeout and malformed acknowledgement reject the barrier. Only one allocation batch is accepted.

The final send result must exactly match the committed batch. The controller closes both endpoints
on success or failure. createBackendTextSender connects this method to OutboxWorker's sender API;
its failures remain OUTCOME_UNKNOWN under the existing conservative policy. A lost acknowledgement
may leave saved IDs with no inserted message, which is still reconciled rather than automatically
resent. Cancelling/terminating after acknowledgement may leave a real send in progress.

Tests cover delayed persistence, callback-copy mutation, matching/mismatched results, save failure,
disconnect, timeout, malformed acknowledgement and projected request validation. The controller
integration test now traverses this MessageChannel barrier, Desktop's real proxy, the built send
controller and SQLCipher before synthetic insertion. A real dedicated backend worker rejects send
before profile open and never invokes persistence. Successful sends through a linked dedicated worker
and process kill-point tests still require validation. Appservice/outbox ingress, portal echo mapping
and runtime startup assembly are not yet connected.


## Decrypted Matrix inbox to outbox

MatrixOutboxIngress now accepts owner m.text events only in a locally mapped portal of the configured
profile. The native transaction decoder explicitly overwrites encryption provenance from the outer
event type after native decryption; Matrix content cannot supply that flag. TransactionInbox schema 2
retains the source transaction ID beside each decrypted event. Existing schema-1 events gain a nullable
column, with no invented transaction ID or encryption provenance. Legacy ambiguous owner events remain
pending for recovery rather than becoming outbound sends.

Ingress prepares a UUIDv7 outbox request before acknowledging the decrypted inbox event. Those commits
span two encrypted stores: a crash between them replays profile/event dedup and reuses the original
request, content and Matrix transaction association. Event replay under a second application-service
transaction does not make the event pending again. The outer HTTP path still acknowledges the durable
encrypted transaction before later decryption/outbox insertion; it does not yet implement the handoff's
literal outbox-before-HTTP-ack order.

Foreign sender/room events are ignored by text ingestion. State events remain pending for a dedicated
state consumer. Unsupported owner events, plaintext owner messages, edits and unmapped replies stay
pending while later valid events in the batch can progress. Known replies resolve through the portal's
message-version map. Reply fallback stripping, native formatted text handling, failed-message notices,
control-event dispatch, batching fairness, startup scheduling and current room-encryption/membership
verification before dispatch remain unfinished. The service must not run this as the sole inbox consumer.

Tests reopen the outbox between commit and inbox acknowledgement, check same-event replay, enforce owner
and portal isolation, preserve unsupported/state inputs, and migrate a real schema-1 encrypted inbox.
Root typechecking, five focused inbox/worker/ingress tests and the real native device exchange probe pass.
The latter verifies crypto compatibility after adding the provenance flag. No live account was used.


## Owner echo association

MatrixJournalSink accepts the profile OutboxStore and checks canonical messages against its allocated
IDs. Matching single-part text echoes must have the expected outbound identity, chat, text and reply.
The sink saves an existing-event mapping with the actual Matrix owner as sender before marking the
outbox part observed. It then skips normal body projection, preventing a ghost-authored duplicate.
Unmatched messages still use normal inbound/phone-originated delivery. Mapping conflicts and pending
projections reject instead of being overwritten. Deleted echoes can establish the original mapping
before normal redaction handling.

Reactions and status delivery continue against the original owner event. An echo can precede send
completion without ACKED being downgraded. A crash after the portal mapping commit but before the
outbox observation commit replays the same mapping, then completes acknowledgement. No cross-database
atomicity is claimed. Mapping versions/history allow normal reply lookup and deletion targeting.

Current text sends create one remote message. Multi-part echo projection still fails visibly until
fragment mapping is implemented. Changed text/reply echoes also stay pending until an owner-authorized
mutation path exists; the bridge does not send an invalid ghost-authored edit of an owner event.
Runtime assembly must pass outbox to MatrixJournalSink. Live Beeper echo/status validation remains
unfinished.

The journal integration test confirms no extra room send for an owner echo, persistent original-event
mapping, early acknowledgement and later delivery status referencing that event. Another test injects
an acknowledgement failure after mapping, reopens SQLCipher, reconciles the uncertain request, and
rejects identity/content conflicts. Focused journal/outbox/echo/message/deletion tests pass.


## Outbound preflight authorization

The backend sender factory now requires a DispatchGuard configuration. Before claiming a PREPARED
request, OutboxWorker runs the sender's check, then rechecks readiness and claims exactly that request
ID. A failed read/check or lost readiness leaves the request PREPARED and invokes no backend send.
The generic worker permits test/custom senders without a check; production assembly must use the
configured backend sender factory.

DispatchGuard verifies the configured profile and Matrix owner against the immutable request and
local portal mapping, fetches fresh room state, and requires exactly one Megolm encryption event,
one bridge marker from the configured bot identifying this owner/profile/chat, and joined owner
membership. Missing/duplicate/wrong state rejects; no stale-cache fallback is used. The mapping is
rechecked after the asynchronous read. It does not create rooms or alter membership. This is a
point-in-time check, not an atomic guarantee against a subsequent homeserver membership change.

Root TypeScript checking and four focused guard/outbox/proxy tests pass. Fixtures cover changed
algorithm, owner, marker sender, network, chat and membership; missing/duplicate state; network
failure; readiness changing during the read; successful recovery; and an incorrect local room mapping
rejected before any HTTP request. All preflight failures keep the row PREPARED with zero backend
sends. Service startup wiring and live Matrix state validation remain pending.


## Outbox hard-kill matrix

The outbox crash suite now forks a real Node process and kills it with SIGKILL at nine reported
checkpoints: before preparation, after PREPARED commit, during read-only preflight, after dispatch
claim, after allocated-ID commit, after the first synthetic part, after all synthetic parts, after
SENT commit and after ACKED commit. The parent confirms the process exit signal before reopening the
actual SQLCipher store and applying normal interrupted-request recovery.

Every case replays the same Matrix request. Before-dispatch cases resume once; DISPATCHING recovery
becomes OUTCOME_UNKNOWN and is never selected for automatic send. SENT/ACKED are also never resent.
The tests reconcile only IDs present in a separately fsynced synthetic effect ledger, in reverse
order and with duplicate observations. A partial two-part outcome remains uncertain; observing both
parts completes acknowledgement. No part appears twice in the effect ledger.

All nine checkpoints and root TypeScript checking pass. This establishes process-crash behavior of
the real outbox store/worker with a synthetic remote side-effect ledger. It does not establish actual
Threema delivery, device reflection, the parent/backend-worker kill windows around acknowledgement,
Matrix native crypto crash consistency, filesystem power-loss behavior or multipart portal projection.
Those remain separate acceptance work; the suite does not complete Gate 0C or live chaos testing.


## Durable preflight retry scheduling

Outbox schema 2 adds canonical chat routing, a retry deadline and a bounded preflight-failure count.
Only read-only preflight failures receive automatic exponential backoff (one second initially, capped
at five minutes by default). They remain PREPARED. Deadlines and attempt counts survive restart, and
no raw failure details are stored. The migration validates existing requests and fills chat routing
in bounded batches inside a transaction; writing while iterating the same SQLCipher connection was
caught by the migration test and corrected.

Selection skips a delayed chat while permitting other chats to progress. A later request in the same
profile/chat cannot overtake an earlier PREPARED, DISPATCHING or OUTCOME_UNKNOWN request. SENT/ACKED
requests no longer hold that chat. Uncertain work cannot be reset by the preflight retry API. Claim
revalidates the selected request against eligibility after asynchronous preflight, so a changed queue
cannot dispatch an unchecked replacement. These semantics require the documented single worker.

Tests cover retry persistence/reopen, exponential deadlines, other-chat progress, same-chat ordering,
an uncertain request holding only its chat, and schema-1 migration. Root typechecking, the guard and
outbox tests, and all nine real SIGKILL checkpoints pass after this change. Operator resolution,
visible retry status and the continuously running service dispatcher remain pending.


## Continuous outbound dispatcher

OutboxDispatcher now continuously drains bounded inbox pages and dispatch batches. It recovers
interrupted requests before starting, accepts inbox work while reconciliation is pending, and gates
all backend dispatch on readiness plus its own stop signal. Deferred/uncertain request failures do
not stop other eligible chats in the batch. Reporting callbacks cannot break processing. Poll waits
are abortable, duplicate start is idempotent, and stop waits for the active operation without claiming
another request. The service still owns backend termination and store closure; stop alone cannot
cancel an already-running backend send or hung preflight.

MatrixOutboxIngress uses a rotating sequence cursor over pending events. Unsupported events and
state events remain available to their consumers but cannot permanently occupy the first page and
starve later text. The cursor resets after reaching the tail and on process restart; durable outbox
dedup makes repeated scanning safe. This does not replace the missing control-event consumer.

createOutboundDispatcher assembles ingress, the mandatory production room guard, backend sender and
continuous worker from owned service resources. The complete application launcher, configuration,
crypto/profile initialization, HTTP server lifecycle and inbound synchronization are still not wired
into a single running service.

An integration test uses real SQLCipher inbox/outbox/portal stores, retained state events ahead of
text, readiness pause/resume, a held send, stop/restart, and throwing reporting callbacks. It confirms
that queuing progresses while sends pause, no second send starts during stop, and remaining work
resumes after restart. Root TypeScript checking and focused dispatcher/ingress/inbox tests pass.
