# Encrypted management room implementation

The command grammar and handler boundary are implemented in `src/management/`.
The provisioner is also implemented, but these components are not yet wired into the running inbox consumer.
No management command is available to a live account yet.

The grammar accepts status, contacts, resync, doctor, version, help and
`!threema pm <ID>` (the prefix is optional inside the dedicated room). IDs use the
pinned upstream ASCII syntax and normalize lowercase ASCII to uppercase. Extra
arguments, control characters, oversized input and invalid IDs are rejected.
Link/unlock/password/QR/recovery/revoke/deletion operations are local-only, with
fixed help that never echoes source text.

The handler checks the exact configured owner and management room, verified
incoming encryption and ordinary text event type. It ignores state events and
message relations so editing or replying to a command cannot accidentally repeat
an administrative action. Fresh room authorization must succeed before execution
or reply. The source event ID is passed to action/reply adapters for durable
idempotency; the handler itself does not persist effects or acknowledgements.

Still required: runtime provisioning integration, durable command
consumption, action adapters and encrypted idempotent replies. The future action
adapters must return bounded non-secret output and persist command results before
acknowledgement. Contact resolution and portal creation must use upstream services;
this parser does not establish that an ID exists.

## Room state policy

`managementRoomState` defines initial Megolm encryption, invite-only membership,
joined-only history, forbidden guest access, an owner/profile marker and bot-only
administrative power. Ordinary owner text/encrypted messages remain sendable.
`assertManagementRoomState` validates a fresh complete state against that policy,
requires the bot-authored marker and both owner/bot joined, and rejects additional
joined/invited/knocking users, ambiguous duplicate state and lowered administration
thresholds. Departed or banned users may remain in historical member state.

`ManagementRoom` provisions through the pinned Matrix SDK, enables encryption
before requests, and requires an alias namespace assertion. Its stable alias
includes a hash of profile, owner and bot. Repeated calls re-resolve and verify
the complete state; concurrent calls share a request. Only a missing alias allows
creation. Alias conflicts resolve again, and a lost creation response recovers
through the same alias on the next attempt without blindly creating again.

Provisioning allows a pending owner invitation. Command authorization still
requires the owner joined, with fresh state fetched on every call. Neither path
accepts additional active members or a foreign ownership marker. This does not
by itself remove unauthorized members or guarantee crypto session rotation.
The runtime must bind the handler to the provisioned room and its authorization
callback. Synthetic tests cover retries, alias conflicts, concurrent/restarted
provisioning, pending invitations and changed authorization state.

## Durable consumer

`ManagementWorker` consumes authenticated owner commands from the durable inbox,
checks fresh room authorization before effects and again before sending, and
acknowledges only after a successful reply. Inbox schema 3 adds immutable bounded
plain-notice results in the existing encrypted database. Versions 1 and 2 migrate
transactionally. Replies use stable transaction IDs for `EncryptedSender`; retry
and restart reuse saved results. Concurrent drains share one operation and a
failed command prevents later commands from overtaking it.

Action adapters must still recover the crash window between an effect and saving
its result using the source event ID. This consumer alone does not promise exactly
once external effects. Runtime attachment, concrete action adapters and live
acceptance remain unfinished.

## Action output adapter

`ManagementActions` implements bounded plain notices for readiness, contacts,
resynchronization requests, local doctor totals and the source version digest.
It explicitly selects fields instead of serializing diagnostic or backend objects.
Contacts are sorted by identity and limited to 100 entries with an explicit total;
display names are shortened and stripped of line/bidi controls. This is not yet a
paginated full contact browser. Doctor output preserves the distinction between
failed and unverified checks. Source version output does not claim installed-native
verification. Resync uses the existing coalescing runtime operation; a crash before
result persistence can request another safe reconciliation.

The start-DM branch requires an injected upstream resolver and returns a room link
only after that resolver succeeds. It passes the source event ID through for effect
recovery. The resolver and runtime dependency wiring remain outstanding; these
commands are still not available to live accounts. Eight focused management tests
and TypeScript checking pass using synthetic inputs.

## Backend contact resolution

The headless session and worker IPC now expose `ensureContact`. The worker uses
Desktop's actual receiver-list controller and identity helper: ASCII normalization,
lookup, group-contact promotion preserving names, or new-contact creation. Synced
device creation races re-read the authoritative directory. Own and invalid IDs
fail; only normalized public metadata leaves the worker. No phone/email lookup
or message send is added. The pinned upstream headless TypeScript build and Vite
bundle build pass; the compiled resolver passes synthetic tests for each lookup
outcome, including a creation race. The contact-to-portal and runtime command
connection are still pending. No live directory request was performed.

## Runtime integration

The service launcher now installs a management pump owned by `ProfileRuntime`.
It lazily provisions the room, consumes durable commands and sends replies through
`EncryptedSender`. The pump retries failures, reports its state and stops before
stores close. Management readiness requires a running runtime and Matrix crypto,
so status/resync remain available during Threema reconciliation. Actual doctor
and source-version functions are connected through explicitly filtered outputs.

`StartDm` connects upstream contact resolution to `c:<ID>` portal creation,
ghost profile creation and membership reconciliation. It returns room and ghost
metadata only after membership succeeds. The runtime requests reconciliation
after a successful start-DM. Retry uses stable contact identity, portal aliases
and ghost mappings. Synthetic start-DM and runtime lifecycle tests pass; complete
native encrypted command ingress and real-account acceptance still need validation.
Earlier statements that runtime wiring is pending are superseded by this section.

## Native crypto room registration

The Matrix session now accepts one explicitly verified management room in addition
to owned portals. Before registering it, the session fetches complete room state,
checks the bot/owner/profile policy, and initializes native room crypto tracking.
Only then may encrypted transactions select the bot for this room. Registration
is session-local: restart requires provisioning/state verification again. Foreign
rooms remain rejected. Management encryption/history state and membership changes
now reach the native room tracker. The management pump registers the room before
constructing its command consumer.

A synthetic HTTP test uses the real native crypto engine to encrypt and decrypt a
management-room notice through session ingress. It also rejects a wrong owner and
a second room and verifies re-registration after restart. This is not yet an owner
device command round trip or real-account acceptance.

## Owner-device round trip

The two-native-device exchange probe now exercises an encrypted owner `status`
command through native transaction decoding, the SQLCipher inbox and
`ManagementWorker`. It rejects an additional invited member before executing the
action. A deliberately lost encrypted reply response leaves the command pending;
a fresh worker reuses its saved result and the identical Matrix transaction and
ciphertext. The owner device decrypts the eventual notice and verifies its reply
reference. The test observes one action execution and one remote reply event.

Both devices, Olm key exchange and Megolm payloads use the pinned native engine.
The transport, room-state snapshot and action result are synthetic. Full service
provisioning plus these device flows and real-account acceptance remain separate
verification work; this is not a claim of live account compatibility.

## Expected contact rejections

The headless resolver now distinguishes unavailable IDs and own-identity requests
with fixed error categories. Worker IPC permits these categories only for contact
resolution. The command adapter converts them into bounded notices which are saved
and acknowledged through the normal encrypted reply path. A failed `pm` therefore
does not permanently block later commands when the upstream result is terminal.
Transport failures, creation races still in progress, and unexpected exceptions
remain retryable and do not acquire a terminal saved result. Tests cover the
compiled upstream categories and durable command ordering across both outcomes.

## Contact pagination

`contacts` now returns the first 100 contacts in ASCII identity order and, when
more remain, an explicit `contacts after <ID>` command. The optional `!threema`
prefix works for both forms. Subsequent pages use a strict greater-than identity
cursor rather than a numeric offset, so deleting an earlier contact or the cursor
contact does not skip entries. Each invocation reads current metadata; contacts
added before the cursor require restarting with `contacts`. Replies still use
immutable persisted results, so retrying one command does not change its page.
Empty directories, exhausted cursors and invalid syntax have explicit handling.
This supersedes the earlier first-100-only limitation.

## Shared inbox ownership

The text outbox previously acknowledged unknown-room events after deciding they
were not chat messages. That could consume a management command before its worker
ran. Text ingress now only acknowledges events in portals owned by its profile;
management and unknown-room events remain for their corresponding consumers.
A regression test queues chat text and a management command in the same durable
transaction, runs text ingress first, and verifies each reaches its own consumer
once. Unrecognized rooms now remain pending until routed or explicitly handled.

## Launcher integration (2026-09-16)

The service launcher now connects the existing actions and durable command worker
to the encrypted maintenance room. It looks up the stable room alias at most once
a minute until found, validating its provisioning policy before automatic owner
joining and command registration. Missing aliases cause no chat creation; an
upstream notice creates the room only when needed. Commands survive restart via
the existing transaction inbox and persisted results, and replies use the durable
encrypted sender. Room authorization is freshly checked before actions and replies.

Status, help, contacts, resync, doctor, version and `!threema pm <ID>` are wired.
Doctor uses the local diagnostic and reports unknown checks honestly; version uses
the staged source manifest, which no longer requires root planning documents.
Local-only commands remain local. The command worker runs before maintenance
notice processing so a malformed monitor state cannot block already accepted
commands. A newly created room can take up to a minute to attach its command worker.

Twelve focused tests passed, covering room lookup without creation, room policy,
durable command retry, action rendering, notification retry, startup failure cleanup
and version packaging. TypeScript checks passed. This is implementation acceptance;
new live management-room command acceptance and release image integration remain
pending. Earlier sections describe the development stages and do not supersede
this current integration status.
