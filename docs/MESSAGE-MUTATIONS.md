# Message edits and deletes

Status: command policy, worker routing, target/content validation, durable journaling,
original-event retrieval, state recovery and failure notices are implemented and covered by
synthetic native tests. Normal service startup now enables the mutation runtime. Live Beeper
compatibility, phone-originated owner-edit convergence and full handoff coverage remain incomplete.
Later sections record implementation changes; earlier verification entries are historical.

The handoff section 13.3 requires editing/deleting only owned outbound messages within upstream
policy, including notes-group exceptions, and convergence for changes made on the phone.

## Pinned policy sources

Paths below are relative to the pinned Desktop checkout's `apps/desktop/src`:

- `common/network/protocol/constants.ts`: edit and delete grace periods are both 360 minutes.
- `app/ui/components/partials/conversation/internal/message-list/internal/regular-message/RegularMessage.svelte`:
  editing requires outbound, nondeleted, sent messages; excludes left groups, audio and polls;
  checks elapsed time strictly below the grace period unless the receiver is a notes group.
- `app/ui/components/partials/conversation/internal/delete-message-modal/helpers.ts`:
  delete-for-everyone requires an outbound sent message, feature support and the same strict
  time cutoff (or notes group). Deleted/status messages are excluded.
- `app/ui/utils/receiver.ts`: notes groups are owned groups with no other members, not left.
- `common/viewmodel/conversation/main/store/helpers.ts`: edit/delete feature support maps
  partial group support to supported, retaining unsupported participant names in the UI.
- `common/viewmodel/conversation/main/message/regular-message/controller/index.ts` and
  `common/viewmodel/conversation/main/controller/index.ts`: use model `editMessage.fromLocal`
  and conversation `markMessageAsDeleted.fromLocal`; local removal is a distinct operation.
- `common/network/protocol/task/csp/outgoing-edit-message.ts`: the task assumes prior feature
  and changed-content checks. Calling a low-level model operation alone does not enforce UI policy.

## Implemented contract

`parseMutationCommand` admits only profile, chat ID, target message ID, action and edit text.
Payloads are snapshotted; delete cannot carry text and neither action accepts caller timestamps,
unknown fields or native handles. Edit text is bounded to the pinned 6000 UTF-8-byte limit.
An empty media caption is allowed; empty text-message content is rejected by native policy.

`mutateNodeMessage` resolves the owned conversation and target, requires group membership and
current edit/delete feature support, rejects inbound/unsent/deleted messages, applies the
upstream window constants and notes exception, and rejects audio/poll edits. Unchanged text
or caption returns without scheduling an edit. Eligible edits/deletes invoke the same model
operations as Desktop. This never substitutes local-only deletion.

The session exposes `mutateMessage`; `BackendController` and the shared worker router parse
the request before forwarding it. The worker permits these error categories:
`mutation-invalid`, `mutation-permission-denied`, `mutation-not-found`, `mutation-unsupported`,
`edit-window-expired`, `delete-window-expired`. Other failures remain opaque backend failures.
These low-level error codes still need mapping to durable user-facing notices.

## Verification and remaining work

The pinned headless bundle builds (790 modules, 7200.34 kB); root and headless TypeScript checks
pass. `tests/entry.mutation-command.ts` passes both tests covering strict payload validation,
UTF-8 bounds, command-data routing, ownership, target lookup, sent status, feature support,
unsupported message types, empty captions, no-op edits, expiry and notes-group/left-group rules.
It runs the bundled headless policy against synthetic model methods; it does not execute actual
native edit/delete tasks or prove network delivery. Existing reaction and worker lifecycle tests
pass, including missing-profile rejection through the real worker for both new actions.
The test is included in the Linux context stager, but these changes have not yet been verified
in fresh Linux images. Build log: `.local/mutation-headless-build.log`.

Required next work includes resolving Matrix replacement/redaction targets only through owned
bridge mappings, durable mutation state and uncertainty handling, checking authoritative state
after restart, native model/task tests, safe policy notices, and inbound owner edit/delete
convergence. Partial recipient support must be surfaced without exposing participant data in
logs. Live policy can change while remote model calls are in flight; native task behavior and
race handling need explicit validation before enabling production dispatch. No account has been
paired and no real edit or delete has been issued.


## Matrix target resolution

`resolveMutationTarget` now classifies Matrix replacements and message redactions without
acknowledging inbox events or invoking a remote operation. Replacements must be encrypted;
redactions use the authenticated Matrix control-event form (including old/new `redacts`
locations). Conflicting targets, self-targets and malformed replacement content are rejected.
Events from other senders, rooms or profiles are ignored.

Confirmed text/media sends resolve through their durable outbox records, retaining every
allocated part in order. Merely allocated or uncertain IDs remain pending, including an echo
that confirms only one part of a split text. Imported phone-originated messages require an
owner-sender mapping in the same profile/chat/room. Ghost/inbound mappings cannot authorize
mutation. Known rejected originals remain rejected. A caller can identify targets awaiting
classification without inventing remote IDs.

Reaction redactions are left to the reaction consumer. Removing/replacing an earlier edit
event is rejected rather than deleting the entire remote message; known replacement events
and non-root mapping versions are detected. The original root remains a valid target.
Replacement content is returned as an immutable snapshot for subsequent normalization; this
resolver does not yet decide how to split edited text or validate media-caption-only changes.

Five focused target/command/reaction tests pass, including real SQLCipher outbox, portal and
inbox stores. The expanded mutation test covers media confirmation, multipart text recovery,
cross-room rejection, phone-owner versus ghost mappings, conflicting redaction formats,
reaction-consumer separation, earlier edit versions and snapshot ownership. Root TypeScript
passes. The new test is included in the Linux context stager. Durable mutation journaling,
replacement normalization, dispatch/recovery and runtime admission remain to be implemented.


## Durable mutation plans (outbox schema 14)

`MutationJournal` now shares the SQLCipher outbox connection. Migration from schemas 0–13
creates immutable mutation operations and ordered per-command parts, preserving existing
text/media/reaction work. The database doctor accepts schema 14. Mutation plans record the
profile, owner, room, chat, source event, original target and canonical scalar commands;
commands may include an edit followed by deletes when a future normalization plan shortens
split text. They must address distinct message IDs in the same profile/chat, have at most
1024 parts and at most 1 MiB aggregate replacement text. Duplicate event replay is accepted
only for the identical canonical plan.

Parts transition from PREPARED to DISPATCHING only through an atomic claim. APPLIED means
the backend operation returned successfully, not proof of recipient delivery. A definitive
policy failure records REJECTED with an allowed public error code and atomically CANCELS the
unattempted tail. This prevents a failed leading edit from being followed by destructive tail
deletes. An uncertain failure records OUTCOME_UNKNOWN. Restart recovery changes interrupted
DISPATCHING parts to OUTCOME_UNKNOWN and never resets them to PREPARED.

Candidate selection preserves per-chat/per-part journal order. Uncertain work blocks later
parts and mutations in that chat while allowing another chat to proceed. Cancelled parts are
terminal and cannot be claimed. Source-event ordering against other outbox consumers still
needs integration before runtime admission; journal insertion order alone is not sufficient.

Text, media, reaction, rejection and mutation classifiers reject duplicate ownership of the
same profile/event. The durable tests cover migration from an actual schema-13 layout,
preservation of prior text work, immutable replay, invalid/duplicate targets, classification
conflicts, partial success followed by restart, no automatic retry, unrelated-chat progress,
allowed failure codes and atomic tail cancellation. Thirteen focused tests pass across
mutation journal/targets, text outbox/rejections, reactions, video recovery, database doctor
and native Matrix encrypted backup/restore. Root TypeScript passes.

The existing backup drill proves compatibility with the new schema; it does not yet seed
mutation rows into its restore scenario. Native mutation execution, authoritative-state
reconciliation, a dedicated mutation backup fixture, replacement normalization, dispatch,
source-order integration and user notices remain incomplete. The journal has no automatic
unknown-to-retry path. No real messages were edited or deleted.


## Mutation dispatcher and cross-kind ordering

`MutationDispatcher` now consumes immutable journal plans. It runs authorization before each
part, rechecks readiness, atomically claims the expected part and only then calls the native
mutation API. Concurrent drain calls share one pump. Authorization receives a separate snapshot
so callback mutation cannot alter the command that is sent. Preflight failure excludes that
chat for the batch while leaving the command PREPARED and allowing other chats to proceed.

Only typed worker policy rejections become REJECTED (cancelling the unattempted tail). Other
backend errors become OUTCOME_UNKNOWN. A successful backend return becomes APPLIED. Failure
to persist completion leaves DISPATCHING, which restart recovery turns into OUTCOME_UNKNOWN;
neither state is a candidate for this dispatcher. No automatic retry is inferred from a missing
response or failed local commit.

`sourceOrderPermits` recognizes accepted mutation plans. Later event classification may proceed,
but cross-kind dispatch waits until every predecessor part is APPLIED, REJECTED or CANCELLED.
This includes Matrix redaction control events that are not Megolm-encrypted. An uncertain part
continues to block later sends in that room. Mutation journal candidate/claim methods now support
batch chat exclusions without changing per-chat ordering.

Nine focused tests pass across dispatch, journal migration/restart, cross-kind source order,
media runtime and reaction runtime. The additional completion-commit failure test confirms exactly
one backend invocation across retry and restart. Root TypeScript passes. Dispatcher tests use real
SQLCipher journals and a synthetic backend; they do not yet prove native edit/delete task behavior.
Runtime factory/ingress wiring, normalization, authoritative-state recovery and failure notices
remain outstanding. No production Matrix event invokes mutation dispatch yet.


## Replacement content validation

`normalizeMutationContent` validates replacement content against an authoritative original
Matrix content snapshot (retrieval and verification are still the caller's responsibility).
Text uses the plain body, preserving whitespace and Unicode; HTML is never sent as native text.
Reply targets cannot change, and the Matrix plain-text reply fallback is stripped from a
replacement reply. Empty text and replacements above the pinned 6000 UTF-8-byte limit are
rejected. The inspected headless `sendNodeText` itself accepts only this size, and the pinned
conversation controller creates one text fragment; it does not provide an oversized-text
splitter to reuse.

For file/image/video, caption addition/removal is allowed while filename and all non-caption
fields must remain unchanged. File descriptors, size/MIME/dimension/thumbnail metadata and
relations cannot be changed through a caption edit. The body-equals-filename form normalizes
to an empty caption. Audio/poll replacement remains unsupported, consistent with native edit
policy for those types. Handling an audio event that originally fell back to a native generic
file requires projection-aware normalization before admission.

Two focused tests pass: Unicode byte boundaries, plaintext/HTML distinction, reply retention,
empty/type-invalid text, caption addition/removal, immutable attachments and audio/poll
rejection. Root TypeScript passes. Durable plan generation from this content, original-content
retrieval (including phone-originated messages), preservation of unavailable-reply fallback
projections, and multipart edit growth/shrink semantics still require integration. This helper
alone does not enable production edit dispatch.


## Ingress and durable plan creation

`MutationIngress` connects target resolution and content validation to the encrypted journal.
It checks source order, uses a stored original inbox event or an injected verified-original
loader, validates original event ID/room/owner/type/encryption and commits the complete plan
before acknowledging the Matrix source event. Retrieval errors remain retryable and absent
originals remain pending. Invalid originals and unsupported replacements receive durable
rejection records; acknowledgement remains the notice consumer's responsibility.

Delete plans include every mapped remote part. A replacement that fits the native text limit
edits the first mapped text part and deletes an obsolete tail; journal rejection/uncertainty
rules prevent destructive continuation after a failed leading edit. Attachment caption edits
require exactly one mapped part. Compound media edits and oversized replacement text are
explicitly rejected, not silently truncated or turned into new unrelated sends. Reply-fallback
text for a bridge send with no native reply target retains the existing labelled fallback
projection and is rechecked against the command byte limit.

Saved plans are reused before any original retrieval or normalization. An inbox acknowledgement
failure followed by restart therefore cannot change the accepted plan. Async original retrieval
is followed by another source-order check before committing. The ingress pump coalesces concurrent
drains; it does not issue remote mutations itself.

Nine focused ingress/content/dispatch/source-order tests pass. The ingress test uses real
SQLCipher stores and simulates failed acknowledgement, restart, unavailable original content,
transport failure and wrong-owner original content. Later deletion waits behind the earlier
edit plan. Root TypeScript passes. The loader itself still needs a bounded authenticated Matrix
implementation and profile shutdown cancellation. Runtime factory, notice ownership and
recovery remain pending; production mutation admission is not enabled.


## Bounded original-event loader

`createOriginalEventLoader` fetches the requested event through the SDK's authenticated streaming
transport using the already-open native client's homeserver/token. It accepts secure homeserver
URLs (or loopback HTTP), encodes room/event path components and binds appservice impersonation
to the configured client user. Authorization runs before download and again after decryption.
The outer event must match event ID, room and owner and be m.room.encrypted; the decrypted event
must preserve those identities and be a message event. The returned encrypted flag is assigned
by the loader, never trusted from server content, and the plaintext content is snapshotted.

A shared timeout/cancellation signal bounds authorization, transport/body streaming and native
decryption waits. Event size is bounded while streaming and after decryption. Body streams and
the per-request dispatcher close on completion/failure; late responses arriving after cancellation
are destroyed. A 404 returns unavailable; other failures reject without exposing remote diagnostic
text. Default limits are 30 seconds and 2 MiB, with bounded configurable ceilings.

The focused synthetic-transport/crypto test passes for valid retrieval, owner/room/event/type
mismatches before and after decryption, permission revocation after decryption, missing events,
byte limits, pre-cancellation, a stalled authorization deadline and late-response cleanup.
Root TypeScript passes. This test substitutes crypto decryption; native Matrix encrypted-event
integration and profile-runtime wiring are still required. The loader's caller must provide
profile/portal authorization and its shutdown signal. No production edits have been enabled.

## Native original-event retrieval evidence

The original-event suite now also encrypts a synthetic message through the pinned Matrix SDK,
closes and reopens its protected native crypto store, verifies the device identity survives,
and retrieves/decrypts the ciphertext through `createOriginalEventLoader`. Authorization runs
before retrieval and after native decryption. Corrupted ciphertext and the same ciphertext
presented in a different room context are rejected; a subsequent valid retrieval still succeeds.
Both original-event tests and root TypeScript pass on macOS ARM64.

This uses a single synthetic device and intercepts HTTP transport; encryption, decryption and
protected-store persistence are real. It does not yet prove cross-device original retrieval,
live homeserver interoperability or Linux execution. Profile-runtime wiring, shutdown ownership
and production mutation admission remain pending.

## Matrix session ownership

`MatrixSession.originalEvents` now creates loaders from the session's already-open native bot
client. It requires a caller-supplied owner and authorization callback, checks portal ownership
before and after that callback, and excludes management rooms without a portal binding. The
session's shutdown signal is combined with optional caller cancellation. Shutdown aborts pending
retrievals and waits for their wrappers/transport cleanup before closing native crypto stores.
Existing loader closures reject after closure; new closures cannot be created on a closed session.

The session integration test retrieves real encrypted synthetic content using the authenticated
bot route, rejects foreign/management rooms before downloading, and closes while authorization
is stalled without allowing a download. Three session/original-event tests and root TypeScript
pass on macOS ARM64. The caller must still supply current owner/room policy authorization;
mutation profile-runtime ingress/dispatch wiring and production admission are not yet enabled.

## Notice classification ownership

The generic unsupported-notice worker accepts an explicit `mutationsEnabled` flag. When enabled,
it defers edit/delete candidates to mutation ingress, including candidates ingress must reject.
Once ingress persists a rejection, the notice worker delivers that reason and acknowledges the
source only after successful delivery. Reaction withdrawals remain owned by reaction processing.
Already-journaled mutation plans are always excluded from generic unsupported classification,
including after restart with admission disabled or an earlier failed inbox acknowledgement.

A real SQLCipher regression test verifies pending edits/deletes and malformed targets remain
unacknowledged until classified, durable invalid-target rejection gets its notice, and a prepared
edit is preserved when admission is disabled. Four mutation-ingress/notice tests and root
TypeScript pass. The flag is not yet enabled by the profile runtime; dispatch failure notices
and mutation runtime wiring remain outstanding.

## Durable native rejection notices

Outbox schema 15 adds acknowledgement records for mutation failure notices. Pending notices
are derived from rejected journal parts, so rejected schema-14 operations become eligible on
migration without changing their execution state. Queries are profile-scoped and paginated;
only successfully delivered notices are acknowledged. An uncertain operation is not reported
as rejected and is not retried by this worker.

`MutationFailureNotices` authorizes a cloned operation, rechecks readiness, and sends a stable
per-event/per-part encrypted-operation ID. Public reason text comes from the six admitted native
policy codes, without replacement text or native diagnostic details. Notices identify the failed
part and count earlier applied and remaining cancelled parts. Failed authorization, delivery or
acknowledgement leaves the notice pending; successful acknowledgement survives restart.

The schema-14 migration test includes one applied part, one rejected part and one cancelled tail,
authorization failure, attempted authorizer mutation, acknowledgement failure after delivery,
restart with the same notice ID, and persistent completion. Six mutation journal/dispatcher,
database-doctor and encrypted-backup tests pass, as does root TypeScript. Runtime scheduling of
this worker remains to be connected. Linux schema-15 verification is still pending.

## Mutation runtime composition

`createMutationRuntime` now composes ingress, dispatch and native rejection notices. Dispatch
checks source order before and after fresh room authorization. Failures in one phase do not
prevent the other phases from making progress; uncertain journal parts remain ineligible for
dispatch. Failure notices use the same room guard without waiting behind unrelated pending work.

`ProfileRuntime` accepts an explicit mutation original-loader factory, requires native
`mutateMessage` support, owns the mutation pump and its cancellation signal, exposes pump status,
and enables mutation ownership in the unsupported-notice worker only alongside this pump.
Readiness requires both native Matrix readiness and completed profile/metadata synchronization.
Shutdown drops readiness and cancels retrieval before waiting for processing loops/backend exit.

The runtime integration fixture proves an edit waits behind earlier text, remains prepared when
fresh owner membership fails, dispatches after authorization succeeds, and delivers one durable
notice for a native deletion-window rejection. The profile lifecycle fixture checks required
native capability and original-loader cancellation. Ten runtime/notice/source-order tests and
root TypeScript pass. The new runtime test is included in Linux staging and available through
`pnpm run test:mutation-runtime`.

Production startup does not yet supply this option. Actual native model/task mutation tests,
authoritative uncertain-outcome recovery, inbound mutation convergence, broader caption/split
semantics and Linux execution are still required before production admission.

## Native whitespace-edit policy correction

Inspection of the pinned outbound model's `editMessage.fromLocal` found that text whose
`trim()` result is empty returns without scheduling a task. The bridge had rejected only an
empty string, allowing whitespace-only edits to be recorded as applied despite that native
no-op. Both Matrix replacement normalization and the headless policy wrapper now reject
whitespace-only text with the existing invalid-edit path. Nonempty text keeps its original
spacing; attachment caption removal remains permitted.

Regression cases cover ASCII whitespace, Unicode trim characters and whitespace after stripping
a reply fallback. The overlay was verified and the headless bundle rebuilt. Seven mutation
command/content/ingress/runtime tests and root TypeScript pass. This correction comes from native
model inspection; it does not replace the still-pending full native model/task execution test.

## Native text model scheduling evidence

The headless probe now exposes the pinned outbound text model store and outgoing edit task class
for synthetic tests. A test instantiates the real model/controller, invokes `editMessage.fromLocal`,
and verifies it schedules a persistent `OutgoingEditMessageTask`. Before the substituted scheduler
resolves, neither the model text nor the database adapter changes. After resolution, the native
controller writes the new text/edit timestamp and appends original and edited history entries.
A rejected scheduling promise preserves the prior model/history/database state. Direct native
whitespace-only editing also confirms that no task is scheduled.

All three mutation-command tests pass against the rebuilt headless bundle; root TypeScript and
upstream overlay verification pass. This test uses real model lifetime guards and edit/history
logic, with a substituted scheduler and database adapter. It does not execute the task's encrypted
protocol exchange or prove remote delivery. Native deletion controller/task execution, recovery
and Linux verification remain pending.

The native text-model fixture also routes a current, sent message through `mutateNodeMessage`.
The bridge promise remains pending while the native scheduler is held, then resolves after the
real model/history update. An identical second edit schedules nothing and adds no duplicate
history. A scheduler rejection propagates through the bridge and preserves the last accepted
text/history. The profile/conversation/viewmodel adapters are synthetic; the text store, controller,
outgoing edit task object and bridge entry point are the pinned implementations. The expanded
three-test mutation-command suite and root TypeScript pass.

## Native mutation task encoding

The native task fixture now runs both `OutgoingEditMessageTask.run` and
`OutgoingDeleteMessageTask.run` for contact and group receivers. It intercepts only the resulting
`OutgoingCspMessagesTask.run` boundary, then decodes the real encoders. All four combinations
preserve the original target message ID, use the correct contact/group update type, carry the
requested operation timestamp, allocate a separate update-message ID, and disable profile
distribution. Group containers preserve group ID and creator identity; edit protobufs preserve
Unicode text. Both tasks propagate failures from the CSP boundary.

The four mutation-command tests, root TypeScript and upstream overlay verification pass after
rebuilding the headless bundle. This proves task selection and encoding with synthetic services;
the CSP encryption/reflection/acknowledgement transport is substituted and recipient delivery is
not tested. Native deletion model-state updates and interrupted-outcome recovery remain pending.

## Encrypted backup mutation drill

The full encrypted backup/restore/adoption fixture now seeds three mutation plans: a partially
applied edit with an in-flight second part, a native rejection with cancelled tail parts and a
pending notice, and another rejection whose notice was already acknowledged. After restoring to
a relocated workspace, the immutable plan is unchanged. Interrupted recovery preserves the applied
part, marks the in-flight part uncertain, and leaves the unattempted tail prepared but ineligible.
Both rejected plans preserve their cancelled tails; only the unacknowledged notice is pending.

The expanded backup drill and root TypeScript pass on macOS ARM64. This exercises the actual
encrypted archive and restored SQLCipher outbox alongside native Matrix key-store restoration;
it does not establish native Threema protocol recovery for uncertain mutations.

Linux ARM64 context v48 (`48d47be2a28ad1942d7379a96c5622a20b514d49b6b21f458713a7ac5494b25e`)
built image `sha256:d440b4e365e746e92fa1ebac650e12bd4d4593b9adadd67eb942fce7f43817a0`.
Its 21 embedded mutation, original-event, Matrix-session and profile-runtime tests passed in
31.2 seconds with network disabled and a read-only root filesystem. Logs are
`.local/linux-mutations-arm64-{build,test}.log`.

The requested backup, database-doctor, generic-notice and source-order files were absent from
that staged context; Node omitted them without failing. They are **not** covered by this Linux
result. Staging now includes these four files; a fresh context/build and explicit file-presence
check are required for their Linux run. AMD64 mutation verification is also pending.

## Corrected multiarchitecture mutation verification

Context v49 included all 14 requested test files; each container checked file existence before
starting Node. Both architectures ran 28 tests: 27 passed, while the backup fixture attempted to
write below the read-only project directory. The fixture now uses a canonical system temporary
directory. Root TypeScript and its macOS backup test pass.

Fresh context v50 SHA-256:
`36743bc075b8b6420e2ac7d88fa7ee7eb033d83280e26ff368f08320042d2ef6`.
Images:

- ARM64: `sha256:f458a372536b06404c96fb994e42fd19e67a1fea38ad304beeb4d181baf51adb`.
- AMD64: `sha256:665051c54698ee97c62d294710a2dfe1a9fee81f31f3ad89cff73241903d8d05`.

Both v50 full runs again passed the 27 non-backup tests. The backup fixture's synthetic proxy
executable then correctly failed production verification under world-writable `/tmp`. Giving
the temporary mount mode 0700 and ownership 1000:1000 (the image's service user) resolved this
without relaxing executable verification. Separate backup-only runs passed on both unchanged
v50 images: 1.54 seconds ARM64 and 5.88 seconds emulated AMD64. Thus all 28 requested tests have
passing evidence per architecture, assembled from the full and corrected backup-only runs,
rather than one all-green full invocation.

All runs used network isolation, read-only root filesystems, dropped capabilities, no-new-privileges
and 768 MiB memory. Final backup mounts used
`--tmpfs /tmp:rw,exec,nosuid,size=64m,mode=0700,uid=1000,gid=1000`.
Logs: `.local/linux-mutations-v50-{arm64,amd64}-{build,test,backup-private-test}.log`.
Diagnostic read-only mounts were used only to inspect the intermediate adoption error, not for
the final passing runs. Native deletion model updates, uncertain-outcome reconciliation and
production admission remain unfinished.

## Native deletion model evidence

The headless probe exposes the pinned `ConversationModelStore` for a synthetic deletion test.
The fixture uses the real conversation controller, message factory/cache, text/deleted model
stores, lifetime guards and outgoing deletion task object. A substituted task scheduler and
database adapter allow the completion boundary to be held and failed without network access.

While scheduling is pending, the database adapter remains untouched. A scheduling rejection
preserves the active text model. Successful completion calls the native deletion path, deactivates
the old model, replaces the last-message store with a deleted-message model and retains the
deletion timestamp while removing text/history. A repeated deletion schedules no additional
task or database change. All five mutation-command tests pass against the rebuilt bundle;
root TypeScript and upstream overlay verification pass. This new fixture has not yet been run
on Linux. Database-adapter behavior and protocol transport remain substituted; authoritative
uncertain-outcome reconciliation and production admission are still pending.

## Read-only mutation convergence query

`readNodeMutation` and the `mutation-state` worker command now compare a validated mutation
target with canonical local state. The query requires the configured profile, matching conversation,
and an outbound sent message. Delete matches only a deleted model; edit matches current text or
caption exactly, excluding deleted/audio/poll models. Missing or mismatched state returns false.
It does not enforce the current edit grace window or schedule mutations: recovery may observe
an already-completed change after that window. The parent validates a strictly boolean response.

Tests cover matching and differing text, deleted/missing/inbound messages, wrong-profile rejection,
absence of mutation calls, invalid worker response type and actual worker rejection before profile
open. The headless bundle was rebuilt; mutation and backend tests, root TypeScript and overlay
verification pass. This API indicates local state convergence, not recipient delivery or which
device caused the change. Recovery journal transitions and runtime scheduling are still pending;
no unknown mutation is automatically retried or reclassified yet.

## Durable mutation convergence recovery

The journal now exposes profile-scoped, cursor-paginated uncertain parts and a conditional
`OUTCOME_UNKNOWN` to `APPLIED` transition when native state matches. False observations leave
state untouched; prepared, actively dispatching and already settled parts cannot be changed by
the recovery transition. No transition returns work to prepared or retries an attempted part.

`MutationRecovery` authorizes before the read-only native query and again afterward, checking
readiness before committing. It passes cloned plans/commands to callbacks. Lookup failures or
authorization revocation leave the attempt uncertain. A settled part releases its never-attempted
tail through existing journal ordering. Recovery is scheduled between ingress and dispatch in
the mutation runtime; explicit profile mutation support now requires both native mutation and
state-query methods.

A real SQLCipher restart test covers mismatched state, transport failure, revoked authorization,
profile isolation, callback mutation, readiness gating, persistent convergence, stale observations
and the distinction between uncertain attempts and unattempted tails. Nine recovery/runtime/
profile/source-order tests and root TypeScript pass. The recovery test is included in Linux
staging. Local convergence does not prove delivery or identify the originating device. Linux
execution of this new recovery path, inbound mutation convergence and production admission
remain pending.

## Bridge-originated text edit echo convergence

Text echo validation now recognizes the latest attempted mutation for the original owner event,
profile, room, chat and remote message. Its text must match exactly and the original reply target
must remain unchanged. Prepared or rejected plans do not establish an accepted edit. Dispatching,
uncertain and applied attempts can explain an echo because native state may update before the
worker response or durable completion arrives. Echo handling itself does not settle mutation
state; the authorized recovery path owns that transition.

The existing owner root mapping is preserved and no duplicate Matrix message is sent for an
explained text change. Unknown changes and superseded attempted edit content remain rejected.
Four echo/recovery/journal tests and root TypeScript pass; the echo test is now staged for Linux.
This covers single-part text edits initiated in Beeper. Phone-originated changes to owner events,
caption edits, multipart projections and full inbound mutation convergence remain pending.

Media echo validation now also accepts exact caption changes explained by an attempted edit for
the original owner event. File, image and video models can match that evidence, including media
that was projected as a generic file. Native audio caption changes are still excluded. All other
canonical prepared metadata checks remain in place. Caption removal works when the native model
omits the caption field entirely.

The video outbox regression covers normal video, video with a thumbnail and original-file
fallback: prepared-only edits cannot explain an echo, an attempted edit can, changed attachment
size remains rejected, and removing the caption preserves the original owner root. Five text/video
echo tests and three audio regression tests pass, as does root TypeScript. Image-caption
regression coverage is still pending. This adds echo
recognition only: projection-aware audio-fallback edit admission and phone-originated caption
changes still need their own handling.

Audio caption-edit admission now consults the immutable outbound projection. An original Matrix
`m.audio` event is editable as a file caption only when its durable media request is audio and its
recorded native output kind is `file`. Native audio output remains rejected. The original and
replacement Matrix types, filenames, encrypted file descriptors and media metadata must still
match; only caption body changes (including removal) are accepted. No event-supplied flag can
enable the fallback exception.

Two SQLCipher ingress fixtures distinguish native audio from file fallback, and a normalization
test verifies explicit projection evidence plus rejection of file, duration, filename and type
changes. Eight content/ingress/runtime tests and root TypeScript pass. Phone-originated changes
and image-caption-specific regression coverage remain pending.

The image-caption regression is now covered by `tests/entry.image-mutation.ts`. It starts from
a Matrix PNG request projected as a resized JPEG with a thumbnail, admits caption addition and
removal through real mutation ingress, reopens SQLCipher after dispatch, and reconciles the
resulting uncertain edit echo without changing the owner root mapping. Filename, MIME type,
size, dimensions, thumbnail type and native message-type mismatches are rejected even when
the caption matches a recorded attempt. The fixture and root TypeScript pass on macOS ARM64;
the test is included in Linux staging and `pnpm run test:image-mutation`. It uses prepared metadata,
not an actual image conversion or native send. Phone-originated owner edits remain pending.

## Runtime recovery ordering regression

The runtime integration fixture now runs both normal-response and lost-response variants. In
the latter, the synthetic backend records the edit and throws, leaving its part uncertain. A
subsequent deletion is durably prepared but cannot dispatch while the state query returns false.
An authorization failure prevents the native query; once authorization and matching state are
available, recovery settles the edit and dispatch releases the queued deletion. The edit is
invoked exactly once, uncertainty produces no policy-rejection notice, and the later native
deletion rejection produces exactly one notice. Both runtime variants and root TypeScript pass.
This covers the composition of ingress, recovery, ordering, dispatch and notices using real
SQLCipher journals with a synthetic backend; Linux execution of these variants remains pending.

## Explicit mutation suite runner

`pnpm run test:mutations` now runs the consolidated mutation/media-echo/runtime/backup selection
through `scripts/entry.test-files.ts`. The runner validates every explicit file before starting
Node and fails if any requested file is absent, a directory or an option. This prevents the
silent missing-file omissions observed in earlier ad hoc Node invocations. It forwards test
failure status and removes the inherited `NODE_TEST_CONTEXT` marker before launching the child
test runner, so invocation from another test does not suppress execution. The runner and its
regression fixture are included in Linux staging.

The fixture verifies that a missing second file prevents the first test from executing, that
valid files actually execute, and that failing tests produce a nonzero status. The runner test
and root TypeScript pass.

## Linux verification of recovery and caption edits

Fresh context v51 SHA-256:
`4c64329383daf2e5fd04532228c7ef65438d12f92d95b2aa9161e6a737033bb2`.
Both images ran `pnpm run test:mutations` followed by `pnpm run test:test-files` successfully:
43 mutation-suite tests plus the explicit-file runner regression per architecture.

- ARM64 image `sha256:20a0272c7eed85e770d378c9e8c580b6326b2828c983d6c4a265ad7ef8e00be8`:
  mutation suite 31.40 seconds, runner regression 0.42 seconds.
- AMD64 image `sha256:f3806da8d4b86a6be5b31fab76beadf8620b20ec4d50f6b17d905efc0155cd1f`:
  mutation suite 36.79 seconds, runner regression 4.78 seconds under emulation.

This is a complete successful invocation on each image, including the backup drill. Network was
disabled; root filesystem was read-only; capabilities were dropped; no-new-privileges and 768 MiB
memory were enforced. The temporary mount was private and owned by service UID/GID 1000, as
required by synthetic proxy executable verification. No diagnostic mounts were used. Logs:
`.local/linux-mutations-v51-{arm64,amd64}-{build,test}.log`.

Coverage includes native model/task fixtures, read-only state queries, durable recovery and
source ordering, image/video/audio-fallback captions, owner echo recognition, native Matrix
original retrieval and backup restoration. These synthetic results do not prove live Beeper/
Threema interoperability. Phone-originated changes to owner events, multipart edit semantics
and production admission remain unfinished.

The consolidated explicit-file mutation suite passed all 43 tests on macOS ARM64 in 31.42
seconds; output is retained in `.local/mutation-suite-host.log`. This host run includes the new
native deletion, recovery, caption admission and echo fixtures beyond the older Linux v50 suite.

## Native text admission limit

The handoff requires mapping all fragments if upstream splits oversized text. The pinned native
text path currently creates one fragment and the headless sender enforces 6000 UTF-8 bytes.
Matrix text ingress now checks that limit after resolving replies and constructing any unavailable-
original fallback. Oversized final text receives a durable rejection with a specific shortening
notice; it is never queued for a native send that cannot accept it. The source event remains
pending until notice delivery. Previously prepared requests are preserved rather than rewritten.

The regression covers 1500 four-byte emoji at the boundary, 1501 over the limit, a short linked
reply whose discarded Matrix quote exceeds 6000 bytes, and a reply whose fallback prefix pushes
its final text over the limit. Ten text-ingress/reply/dispatcher/notice tests and root TypeScript
pass. This aligns admission with current native behavior; it does not implement a new splitter
or claim full multipart edit support.

## Repeated deletion convergence

Mutation dispatch now uses the available native state query before a prepared deletion. When
canonical state already shows the outbound message deleted, fresh authorization is checked again,
then the journal claim/completion barrier settles the part without scheduling another delete.
This avoids false missing-message failures for tail parts removed by an earlier shortening edit.
A failed query or revoked authorization keeps the plan prepared; readiness is checked before
query and before claim. When native state does not match, normal mutation dispatch still applies.

The SQLCipher regression proves post-query authorization failure cannot settle a part, disabled
readiness does not query, a confirmed deleted part completes without a native mutation or failure
notice, and later drains do no extra work. Six dispatcher/runtime/recovery tests and root
TypeScript pass. This handles repeated delete steps; full multipart send/echo projection and
phone-originated owner edits remain unfinished.

## Mutation worker integration

A dedicated-worker fixture now connects the real `BackendController`, shared session router,
headless mutation entry point/state reader and pinned outbound text model. The profile adapters,
database adapter and task scheduler are synthetic. Across actual worker messages, the state query
matches original text, changes after editing, rejects stale text, and returns false for missing
or non-deleted messages. A separate malformed-response fixture confirms the parent rejects a
string instead of a boolean.

The test exposed a missing public error mapping on `mutation-state`; the router now preserves
only its native validation and permission-denied codes, leaving unexpected errors generic. Five
worker/lifecycle tests and root TypeScript pass. The new worker fixture is included in Linux
staging and the consolidated mutation suite. Native protocol transport and persisted Threema
profile opening are not exercised by this fixture.

## Mutation read cancellation and deadlines

The mutation runtime now bounds authorization, original-event lookup and native-state reads with
an optional profile cancellation signal and a 30-second default deadline (configurable up to
60 seconds). ProfileRuntime supplies its mutation shutdown signal. Aborting the profile drops
mutation readiness and releases pending read waits; subsequent drains do no work. Actual mutation
execution retains the backend termination/journal uncertainty path rather than being treated as
a cancellable read.

Two SQLCipher runtime fixtures stall authorization or state lookup, abort while the drain is
pending, then release a late successful result. The drain terminates and the recorded edit stays
uncertain; no mutation or notice is sent. Eight runtime/profile tests and root TypeScript pass.
The wait boundary does not forcibly terminate every underlying SDK read; late authorization work
may finish internally, but it cannot continue recovery settlement through the cancelled wrapper.
Notice-send cancellation and broader service shutdown deadlines remain separate outstanding work.

A separate deadline regression now seeds uncertain edits in two chats. The first native-state
read stalls until its 25 ms test deadline; the second chat still converges to APPLIED in the same
recovery batch. Releasing the first read successfully after that batch leaves it OUTCOME_UNKNOWN,
with no native resend or failure notice. This verifies deadline behavior independently of profile
shutdown cancellation. The consolidated host mutation suite passes all 48 tests (31.41 seconds),
and root TypeScript passes. These latest changes have not yet been verified in fresh Linux images.

## Linux verification of worker reads and deadlines

Fresh v52 service images use context SHA-256
`db1348baa930c6d6640206ea7c7e8e69aa68fa381e118c9ead152f9f19badd46`.
Both ARM64 and emulated AMD64 pass all 48 consolidated mutation tests, including the actual
worker boundary, repeated-delete convergence, shutdown cancellation, and cross-chat deadline
regression. Each image also passes the explicit test-runner regression; no tests were skipped.
The mutation suites took 31.39 seconds on ARM64 and 36.91 seconds on emulated AMD64.

Images:
- ARM64 `threema-beeper-service:mutations-v52-arm64`, image SHA-256
  `4a8dc9250cd806db68738ac165d6e2783040d57fbc0b29f81e23380f4d8ed1e1`.
- AMD64 `threema-beeper-service:mutations-v52-amd64`, image SHA-256
  `11a1b570fa0aac0821d12b1e8008c01b236b6a91140a90d2d2e776653eb4689f`.

Runs used `pnpm run test:mutations && pnpm run test:test-files`, network disabled, a read-only
root filesystem, all capabilities dropped, no-new-privileges, and 768 MiB memory. The temporary
filesystem was private to UID/GID 1000. Logs are in `.local/linux-mutations-v52-*-test.log`.
This verifies synthetic native Linux integration; production admission and live account gates
remain outstanding.

## Service launcher admission

`startService` now supplies `mutationOptions` to ProfileRuntime. The resulting original-event
loader uses the already-open Matrix session, the configured owner and the mutation shutdown
signal. Its authorization callback requires a portal in the active profile and fetches fresh
room state through DispatchGuard: encryption, bridge marker and current owner membership must
all match. MatrixSession additionally checks portal scope before and after this callback, and
the event loader repeats authorization after retrieval/decryption. Mutation dispatch retains
its separate fresh authorization and source-order checks.

Five profile-runtime tests and the missing-identity startup regression pass, as does root
TypeScript. The new wiring test proves repeated authorization observes membership revocation,
foreign/unknown rooms never trigger room-state retrieval, and the shutdown signal is passed to
the session. This is not a successful live service startup or account compatibility test. The
v52 Linux evidence above predates launcher admission; fresh Linux verification remains required.
