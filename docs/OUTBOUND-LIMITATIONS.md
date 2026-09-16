# Outbound unsupported-action notices

The profile runtime now has a dedicated durable-inbox consumer for encrypted
owner actions in known portals that the current outbound text bridge cannot send.
It reports unsupported media/message types, reactions, redactions, edits/thread
relations and some malformed text/reply inputs using fixed encrypted `m.notice`
responses. Notices refer to the source event without quoting its body or filename.

Before sending, the worker rechecks room encryption, bridge ownership and owner
membership through the same fresh-state dispatch guard as outbound text. It uses
the persisted encrypted sender with a stable operation ID derived from the source
profile/room/event. It acknowledges the incoming event only after delivery;
failures retain it for retry. Unencrypted input, other senders, foreign portals,
state events and supported text are not consumed by this worker.

This is feedback for missing features, not their implementation. Outbound media,
reactions, edits, deletes and complete malformed-input handling remain unfinished.
Rejection decisions and their original reason are now persisted in outbox schema 3
before notice delivery. Outbox preparation rejects those event IDs permanently,
so later feature additions cannot silently send previously rejected input. Users
can issue a new action with a new event ID after a feature becomes available. Live Beeper notification behavior has not yet been tested.

## Reaction backend adapter

The headless backend now exposes apply/withdraw reactions by canonical profile,
chat and message ID. It validates against the pinned Desktop single-emoji set,
checks the opened identity and group membership, resolves the retained message,
and calls the same model operations as Desktop's regular-message controller.
Missing/deleted messages reject. Bounded worker IPC and synthetic tests cover
apply/withdraw, invalid emoji, identity/chat mismatch and deleted messages.
The bundle and TypeScript checks pass.

This is a backend primitive only: durable outbound control dispatch, Matrix target
mapping, policy notices and reaction withdrawal mapping remain unfinished. Runtime
Matrix reactions therefore still receive the existing unsupported notice.

The same IPC test found and fixed a contact-resolution argument bug: ensureContact
must send identity as command data, not the separate password argument. This fix
is covered by a regression check without starting a profile or accessing accounts.

## Reaction target resolution

`resolveReactionTarget` scopes owner reaction annotations to an owned portal and
requires verified encryption. It resolves retained Matrix message versions or the
original outbound source event. Outbound targets wait until SENT/ACKED rather than
trusting allocated IDs after an uncertain send; every multipart message ID is
preserved. Cross-conversation targets and durable prior rejections are rejected.
The new event lookup reads existing encrypted outbox records without schema changes.
Tests exercise uncertain sends resolving through canonical echoes, multipart IDs,
room/profile boundaries and prior rejection preservation.

This resolver is not yet attached to runtime dispatch. Pending raw target events
not yet ingested into the text outbox need coordinated handling, and durable
reaction dispatch, withdrawal mapping and final emoji/policy notices remain pending.

## Durable reaction journal

Outbox schema 4 adds reaction operations and per-message-part progress on the
existing encrypted connection. Preparation is immutable and deduplicated by profile
and Matrix event ID, and excludes events already classified as text or rejected.
Claiming commits DISPATCHING before a remote call. Completion records SENT or
OUTCOME_UNKNOWN; startup moves interrupted dispatches to OUTCOME_UNKNOWN without
making them sendable again. An uncertain part blocks later reaction work in that
chat while other chats can progress. Multipart targets retain ordered progress.

The journal is not yet a running dispatcher. Recovery of uncertain outcomes from
canonical reaction state, coordination with text ordering, pending target ingestion,
withdrawal mapping and runtime capability changes are still required. Existing
unsupported-action handling remains active until that integration is complete.

## Reaction dispatcher

`ReactionDispatcher` now selects unattempted parts, awaits authorization and
rechecks readiness before committing a claim. The backend call occurs only after
DISPATCHING is durable. Success records SENT; an exception records OUTCOME_UNKNOWN
and does not retry the mutation. Preflight failures leave PREPARED intact and skip
that chat for the current drain so unrelated chats progress. Claims verify the
expected event/part after the asynchronous authorization boundary, and concurrent
drains share one execution. Tests assert state at the backend call and per-chat
ordering after errors.

The dispatcher remains unwired while ingress, terminal backend rejection
classification, uncertain-state reconciliation and withdrawal target mapping are
unfinished. It currently conservatively treats all backend exceptions as uncertain.

## Reaction ingress

`ReactionIngress` now consumes verified encrypted owner annotations from owned
portals. It waits for known same-room outbound text still in the inbox or awaiting
send confirmation, commits immutable reaction targets, and only then acknowledges
the source event. Replaying the journal-before-acknowledgement crash window reuses
the operation. Missing targets produce durable rejection reasons and remain pending
for encrypted notice delivery. No remote mutation occurs in ingress.

Runtime activation still awaits withdrawal mapping, terminal backend failure
handling, uncertain outcome recovery and coordination with the existing unsupported
notice worker. The new ingress is not yet started by the service.

## Withdrawal target mapping

The durable inbox now preserves legacy top-level `redacts` targets as well as
modern content targets. `resolveReactionWithdrawal` accepts owner-authored Matrix
redaction controls for owned portals, resolves the original apply operation and
copies its immutable emoji/message IDs into an ordered withdrawal operation.
Conflicting target fields, foreign ownership and withdrawal-of-withdrawal are
rejected. Ordinary message deletions remain for their separate consumer. If the
original reaction is still awaiting ingestion, withdrawal waits for its mapping.

Matrix redaction controls normally arrive outside Megolm. Accepting them here is
based on authenticated transaction provenance plus exact owner/portal/target
ownership; dispatch still needs fresh room authorization. This does not relax the
encryption requirement for reaction annotations or text. Runtime remains disabled
until duplicate-reaction semantics, uncertainty recovery and notice coordination
are complete.

## Duplicate reaction references

Before each claimed part, the dispatcher compares active Matrix reaction
references immediately before and after that operation, scoped to owner, room,
chat, emoji and remote message. Duplicate applies and repeated redactions settle
without another remote mutation. Removing one duplicate leaves the emoji present;
removing the last reference withdraws it. Reference history is read only through
the current operation, so future queued applies cannot alter an earlier decision.
This works across restart using the encrypted operation journal. SENT includes
these verified no-op settlements as well as successful backend calls.

Current reference reconstruction scans that chat's operation history; indexing or
checkpointing will be needed if long histories make this too costly. Terminal
backend rejection and uncertain-outcome reconciliation must account for reference
history before runtime activation.

## Definite backend rejections

The headless reaction adapter emits fixed categories only for invalid input,
wrong-profile/left-group permission failure and missing/deleted targets detected
before a mutation. Worker IPC admits these categories only for reaction requests.
Unexpected exceptions after entering the model operation remain uncertain.

Outbox schema 5 adds REJECTED parts and persistent per-part failure reasons. It
transactionally expands the schema-4 state constraint while preserving existing
parts. The dispatcher settles known rejections without blocking later work in that
chat; reference reconstruction excludes rejected applies/withdrawals so rejected
work cannot suppress a later valid apply or keep a phantom reaction active.
Failure notices are stored but their delivery worker remains to be connected.

## Reaction rejection notices

`ReactionFailureNotices` reads unreported per-part failures, checks fresh room
authorization and readiness, and emits fixed plain-notice content for the encrypted
sender adapter. Its stable transaction ID includes profile, room, event and part.
A successful send precedes the durable notified flag; failure or restart preserves
the same notice identity. Notices identify the affected part for multipart targets
and never serialize raw backend errors. Tests cover failed authorization, lost
responses, reopened stores and concurrent drains. Runtime sender/pump attachment
and uncertain-outcome notices remain outstanding.

## Uncertain-state observation

The headless backend now exposes a read-only reaction-state lookup scoped to the
opened profile, conversation, message and emoji. It checks only the owner's
reaction, not another participant's matching emoji. `ReactionRecovery` reauthorizes
and reads current backend state for uncertain parts. Matching desired state settles
the part; mismatch or read failure leaves it uncertain and never triggers a resend.
This is convergence of retained local state, not evidence of recipient delivery.
Tests cover apply/withdraw observations, denied authorization and compiled backend
owner filtering. Runtime attachment and notices for persistent mismatches remain.

## Reaction runtime attachment

`ProfileRuntime` now starts a reaction pump when both reaction mutation and state
lookup are available on its backend (the production backend provides both). The
pump runs ingestion, observation recovery, dispatch and failure notices, isolated
so one failed stage does not starve the rest. It uses the same synchronization,
metadata and Matrix readiness gates as outbound work, fresh portal authorization,
and the persistent encrypted sender for failure replies. Shutdown stops the pump
before resources close; status exposes its pump state.

Unsupported notices now defer supported annotations and known reaction withdrawals
to this pipeline, while honoring durable prior rejections. Authenticated owner
redaction controls can receive encrypted notices despite not being Megolm events.
Tests run the notice worker before reaction processing and verify apply/withdraw
reach the backend without false unsupported notices, plus runtime shutdown.

Earlier statements that reaction runtime is disabled are superseded. End-to-end
live delivery, inbound reaction echo reconciliation, persistent mismatch notices,
unified text/control ordering and performance validation remain unfinished.

## Owner reaction echoes

Inbound reaction projection now consults active owner Matrix references from the
outbox journal. An owner emoji already represented by a Matrix reaction does not
produce another ghost event. A pre-existing ghost duplicate is redacted and its
mapping removed, leaving the owner's event intact. Matrix withdrawals remove their
source reference; rejected applies do not contribute one. Synthetic tests cover
initial ghost projection, owner-reference adoption, duplicate cleanup and replay.

Phone-originated withdrawal of an owner Matrix reaction still needs source-event
redaction and reference retirement. Pending withdrawal versus stale snapshot
handling and multipart convergence also require additional verification. This
change establishes echo suppression, not complete bidirectional reaction convergence.

## Phone-originated reaction removal primitive

`retireAbsentReaction` handles settled owner references using fresh backend reads.
It refuses to decide while reaction work in that chat is pending, and preserves a
multipart Matrix annotation if any target part still has the owner's emoji. When
all parts are absent it saves a redaction plan before sending a stable Matrix
redaction, then marks completion. Planned/completed retirements are excluded from
active references and future duplicate-reaction calculations. Schema 6 persists
these plans; restart completes a pending plan without changing its target.

This primitive has synthetic persistence and retry coverage but is not yet polled
by the runtime. Candidate pagination, message-deletion handling and fresh-state
race testing remain before complete phone-to-Matrix removal convergence.

## Retirement polling in runtime

The reaction pipeline now includes a paginated retirement worker backed by the
persistent Matrix redaction sender. Its cursor advances past present reactions and
failed checks, wraps at the end, and excludes completed retirement plans. Explicit
Matrix withdrawals no longer require a redundant retirement decision. The runtime
test now covers apply, Matrix withdrawal, reapply and subsequent phone-originated
removal observed through backend state. A separate page-size-one test verifies
later candidates are not starved by an earlier still-present reaction.

Live acceptance, missing/deleted backend targets, stale inbound owner-reaction
snapshots, unified outbound ordering and large-history performance remain open.

## Stale owner-reaction snapshots

Before projecting owner emojis, the runtime-backed reaction delivery reads current
backend state for owner emojis present in the incoming snapshot or existing ghost
mapping. It suppresses stale additions after withdrawal and preserves current
reactions when an older snapshot lacks them. All such reads complete before any
reaction-side Matrix mutation; lookup failure leaves projection pending. Non-owner
reactions still follow canonical journal snapshots. Tests cover both stale-state
directions, backend outages, echo adoption and pending-withdrawal replay.

These reads are point-in-time observations, not a cross-service transaction.
Missing/deleted backend targets and races after the last observation still need
validation alongside the live acceptance suite.

## Deleted targets and departed groups

Reaction-state reads now distinguish a retained deleted-message tombstone from a
missing lookup: the tombstone confirms no reaction, while missing messages or
conversations still fail rather than imply absence. Read-only inspection is also
allowed for retained left-group messages; mutation continues to reject left-group
operations. This lets retirement and stale-snapshot checks inspect retained state
without accidentally relaxing send permissions. Compiled backend tests cover the
distinction, left-group reads and denied mutations. Uncertain applies whose target
was deleted still remain unresolved rather than being falsely marked delivered.

## Reaction queue metrics

The service metrics endpoint now includes fixed gauges for prepared, dispatching
and uncertain reaction parts, unreported rejection notices and pending Matrix
redaction plans. Counts are scoped to the configured profile and read from the
encrypted journal. They use no event IDs, contact identities or emoji labels.
Tests cover real journal counts after restart, profile isolation, notice completion
and rejection of non-finite, negative or fractional metric values. These gauges
make persistent uncertainty visible but do not replace alert rules or management
room warnings for unresolved work.
