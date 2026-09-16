# Encrypted Matrix portals

`PortalManager` accepts the native-encryption bot SDK intent (`bridge.getIntent(...).botSdkIntent`)
and a SQLCipher `PortalStore`. It enables the intent's crypto before creating or adopting a portal.
Creation is private, invites the configured owner, and includes `m.room.encryption` with Megolm in
initial state. It includes `m.bridge` metadata identifying the profile and canonical chat.

The stable alias localpart is `threema_` plus a hash of profile identity and chat ID; configure that
namespace in the appservice registration. The manager resolves it before creating. A directory
lookup failure other than M_NOT_FOUND does not trigger creation. If creation succeeds but its reply
is lost, a retry resolves the alias instead of making another room. A concurrent alias conflict is
also recovered by resolution. Concurrent local calls for the same chat share one promise.

Before binding or reusing a room, the manager reads its state and verifies both the Megolm algorithm
and bridge metadata authored by the configured bot, naming the configured owner, profile and chat.
Foreign or unencrypted rooms fail closed. The encrypted store refuses mapping conflicts and retains
room IDs across restart. It does not silently replace a mapping when a room disappears.

`pnpm run test:portals` exercises the actual pinned Matrix SDK with synthetic HTTP responses: private
encrypted creation, lookup outage, lost creation reply, alias recovery, mapping reopen, concurrent
ensure calls and foreign/unencrypted-room rejection. Native crypto setup itself is covered by the
separate Gate 0 probes; this portal test mocks intent initialization. No Beeper room was created.

Ghost/member reconciliation, room metadata updates, event delivery and framework RoomBridgeStore
integration remain pending. Beeper's live support for alias-based recovery remains a Gate 0D check.

## Durable encrypted sending

`EncryptedSender` accepts a joined native SDK intent and the portal store. Callers supply a verified
portal, event type, JSON content and a stable operation ID (for journal delivery, the journal's
persistent operation ID). It checks the room's current Megolm encryption state before every network
send, encrypts through the native SDK, and commits ciphertext to SQLCipher before issuing a Matrix
PUT with that operation ID as the transaction ID. It never falls back to plaintext or uses the SDK's
random transaction ID sender.

A lost response leaves the operation pending. Retry, including after store reopen, uses the same
ciphertext and transaction ID. Completion persists the Matrix event ID and removes the stored
ciphertext; subsequent calls return that event ID. Reusing an operation ID with another sender,
room, event type or content is rejected. Concurrent calls within one sender share the request only
when their fingerprints match. JSON is snapshotted before async work to prevent caller mutation.
This relies on Matrix transaction deduplication and stable device credentials; live homeserver
acceptance remains unverified. Crypto preparation may distribute session keys before the event
operation is saved; this does not send the room message.

The schema migrates portal stores from version 1 to 2. `test:encrypted-sender` tests lost replies,
restart, concurrent/conflicting requests, content validation and fail-closed encryption state.
`probe:matrix-devices` now routes both directions through this sender with actual native Olm/Megolm,
including a lost reply and reopened operation store, and verifies recipient decryption. Its Matrix
transport is synthetic. Ghost membership and the concrete journal sink still need wiring.

## Ghost identities and membership

`GhostManager` derives reversible Matrix IDs from the hexadecimal UTF-8 bytes of the uppercase
profile and remote identity: `@threema_<profile hex>_<identity hex>:<domain>`. This supports gateway
IDs beginning with `*` without lossy character replacement. Registration must reserve this user
namespace in addition to the portal alias namespace. SQLCipher schema 3 records the profile-scoped
identity mapping and rejects collisions or changed mappings.

Ghost preparation registers the SDK intent and enables its native encryption before profile updates
or joining a portal. Name updates compare the Matrix profile first and serialize per ghost, so a
newer name cannot be overwritten by an older in-flight update. Threema verification levels are not
translated into Matrix device trust.

Membership reconciliation takes an authoritative list of remote identities and serializes work per
room. It verifies the stored portal mapping, encryption and bridge marker, removes stale mapped
ghosts, then invites and joins desired ghosts. It leaves the owner's account, other profiles'
ghosts, and unmapped users alone. It reads Matrix membership on every retry, allowing successful
joins with lost responses to converge without another invite. Bans fail visibly. Only locally mapped
ghosts are eligible for removal. Names/avatars and room membership are Matrix-visible metadata.

`test:ghosts` covers gateway ID encoding, ordered name updates, mapping reopen, lost join replies,
foreign/unmapped member preservation, stale ghost removal, bans and ownership rejection. SDK profile
and room-state requests use synthetic transport; registration, crypto initialization and joins are
mocked here. Existing native crypto probes cover their separate crypto path. Wiring group/contact
snapshots into this manager, avatar updates, and ensuring crypto has consumed membership changes
before journal sends remain required integration work.

## Message event relationships

`MessageDelivery` projects text bodies through `EncryptedSender` and persists root/latest Matrix IDs
per profile, chat and canonical message ID. A content change sends `m.replace` against the original
event; a subsequent edit back to earlier text remains a distinct operation. Receipt-only changes do
not resend the body. Replies target the original event, including when it has been edited. Missing
reply targets retain the canonical reply ID in bridge metadata. Original creation time is preserved
in encrypted content metadata; homeserver timestamp override is still pending.

Before sending, schema 4 stores a pending projection containing the exact rendered body and reply
relationship. This prevents a changed local reply mapping from changing a retry's payload. Only one
unfinished projection may exist per canonical message. After encrypted send completion, mapping
update and removal of the pending body happen atomically. A crash between send and mapping commit
replays the persisted plan against the sender's completed operation. Stores retain message IDs and
fingerprints rather than completed message bodies. Callers must process journal changes in order.

`test:message-delivery` verifies send-before-mapping recovery, restart, body deduplication,
replacement edits, edit-back-to-original, reply targets and stable creation metadata. It stubs the
already separately tested encrypted sender boundary. This component handles body projection, not
full journal acknowledgment: media, polls, redactions, reactions, receipts and the service-level
journal sink remain to be implemented. Unsupported future messages get a fixed notice; known media
and deleted records explicitly require their own handler and cannot be silently acknowledged here.

## Native recipient membership verification

Inspection of the pinned RustEngine confirms it fetches eligible room members for each new
`encryptRoomEvent` call before sharing the session. The bridge overlay now rejects failures in any
required membership lookup and rejects empty recipient sets; it cannot silently continue with a
partial set. The native two-device probe verifies session rotation after removal and decryption on
rejoin, with absence-period messages remaining unavailable under `joined` history visibility.

These checks apply to newly encrypted events. Retries of already prepared ciphertext preserve the
original transaction payload and its original session; they do not re-encrypt against a changed
membership snapshot. Live transaction ordering, pending-send membership changes and the portal's
history visibility policy still need end-to-end validation.

## Journal sink assembly

`MatrixJournalSink` now assembles PortalManager, GhostManager, MessageDelivery and EncryptedSender.
Construct it with the bot's native SDK intent, a native intent factory for ghost IDs, profile/owner/
domain configuration, the portal store and a callback reading the journal's durable metadata.
Pass it to JournalDelivery with the profile synchronizer's readiness predicate. The factory must
return the SDK intent (`bridge.getIntent(mxid).botSdkIntent`) with protected native crypto storage.

Metadata application prepares ghost names, creates/verifies portals, converges room names and
reconciles contact/group membership. Text delivery reads the durable snapshot even if its metadata
was acknowledged before restart, verifies the portal and current sender membership, and commits
message mappings before JournalDelivery removes the journal change. It uses the profile's ghost
for outbound echoes; owner double-puppeting/outbox echo matching is not yet wired.

The assembly currently rejects media, poll/deleted records, reaction-bearing messages and messages
with read/delivery/deletion effects so they stay visibly pending instead of being acknowledged as
fully handled. Historical messages authored by departed group members also remain pending for a
history-specific policy. These are implementation gaps, not a supported production feature subset.
Metadata avatars, archive/pin/unread state, and service boot/configuration remain unfinished.

`test:journal-sink` integrates both SQLCipher stores and all five components using actual SDK request
construction with synthetic HTTP, membership and crypto responses. It verifies metadata-first
preparation, a lost send response, restart with metadata already acknowledged, ciphertext reuse,
event mapping before journal removal, replacement edits, and unsupported effects remaining queued.
The separate two-device native probe supplies actual crypto coverage; this sink test mocks crypto.

## Reaction convergence

The sink now applies the complete canonical reaction set after body delivery. Schema 5 records each
reaction by profile, chat, message, sender identity and emoji. Additions send encrypted `m.reaction`
annotations against the original message event via the sender's ghost. Withdrawals redact the
mapped reaction event using the bot, then remove its mapping. A failed addition or withdrawal keeps
the journal change pending. Operation IDs include the journal change and reaction/action identity,
so retries converge and a later re-add creates a fresh reaction event.

`RedactionSender` uses Matrix's control endpoint with a stable transaction ID and an empty body.
Redactions themselves are not encrypted message events. The shared encrypted operation store
records their request fingerprint and completion; conflicting ID reuse is rejected. Permission
failures remain pending. Portal verification precedes these operations in the sink; the sender
itself must only be called with an authorized mapped target.

The integrated journal test now covers lost addition responses, withdrawal response loss followed
by restart, and remove/re-add. The native two-device probe encrypts and decrypts the reaction
payload. Homeserver/client aggregation of encrypted reactions and bot redaction privileges still
require live Beeper validation. Reactions by historical departed members remain blocked for the
history handler; media, message deletion and delivery/read status are still pending implementation.

## Message deletion

Schema 6 retains every newly projected message event ID, including intermediate edits, until and
after redaction. DeletionDelivery records a permanent deletion marker before remote work, redacts
all recorded versions and active reaction events with stable transaction IDs, and marks completion
only after each succeeds. Journal acknowledgment follows completion. The sink permits deletion of
messages from departed senders without rejoining their ghosts. Direct body/reaction projectors
reject deleted targets; the ordered sink consumes stale snapshots after completed deletion without
recreating content.

A message first observed as deleted records a durable tombstone without creating a new Matrix
message: there is no previously bridged content to redact. Original message mappings remain for
identity/reference purposes after deletion. The mapping store retains IDs, not plaintext old bodies.

Migration from schemas before 6 can recover root/latest IDs but cannot prove which intermediate edit
events existed. Such mappings are explicitly marked with incomplete history. Their deletion remains
pending for a future Matrix event-history reconciliation, rather than falsely claiming all versions
were removed. No live account had been connected by these development schemas. New mappings have
complete version tracking.

The integrated journal test verifies multiple edits plus reaction redaction, lost deletion response,
restart, stale snapshot suppression and first-observed-deleted records. `test:deletion-migration`
verifies legacy incomplete history is blocked. Live Beeper redaction behavior remains unverified.

## Read receipts and upstream status evidence

StatusDelivery now runs after body and reaction convergence. Schema 7 persists the strongest observed
status timestamps and a receipt position per profile/chat/reader. Outbound `sentAt` is chat-server
acknowledgment, `deliveredAt` is the recipient's received receipt, and `readAt` carries upstream read
reflection evidence. Inbound read state concerns the local profile. These meanings follow the pinned
Desktop `CommonBaseMessageView`/`OutboundBaseMessageView` documentation.

The bot sends this evidence in encrypted `com.threema.message_status` events referencing the original
message. This is a bridge-specific event; rendering it as Beeper's native send-status UI is still
unfinished. It never reports Matrix delivery as proof of Threema delivery. Previously observed status
does not regress when a later snapshot omits timestamps.

Read receipts use the SDK's `m.read` endpoint from the local profile's ghost for inbound messages and
the contact's ghost for outbound direct messages. Group aggregate read evidence produces a status
event without inventing per-member receipts. Receipt positions advance by canonical ordinal/ID,
not creation timestamps controlled by remote senders. They commit after HTTP success. Lost responses
retry the same target; older backfill cannot move the durable position backward. Calls must remain
serialized in journal order. Owner-account read synchronization still needs double-puppeting; the
local-profile ghost receipt alone does not mark the actual owner's Beeper account read.

`test:status-delivery` covers sent/delivered/read distinction, lost receipt response and restart,
status deduplication, older-message suppression, inbound-reader selection and group attribution.
The integrated sink test now delivers an inbound read update through encryption and the receipt
endpoint. Transport is synthetic. Live receipt display, mobile notification behavior and native
Beeper send-status integration remain unverified.
