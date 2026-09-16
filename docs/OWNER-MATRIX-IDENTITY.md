# Owner identity for phone-originated message changes

## Current result (2026-09-15)

**Fixed and enabled:** the reduced launcher now uses `ownerBridgeIntent`: the bot's
existing crypto encrypts the event, while an owner-scoped appservice client sends it.
This matches the [upstream message path](https://github.com/mautrix/go/blob/main/bridgev2/matrix/intent.go)
and [appservice double-puppet authentication](https://github.com/mautrix/go/blob/main/bridgev2/matrix/doublepuppet.go).
It requires no owner-device login, key upload, global room lookup, or session renewal.
The separate owner-device capability below is retained for future compatibility work
and is not invoked by the reduced launcher.

Owner identity is verified at initialization. DispatchGuard checks current portal
ownership, encryption and owner membership before encryption and again before sending.
The transport allows only encrypted message PUTs to authorized portals. Durable send
records retain the actual owner sender and suppress reflected events, including lost
responses; existing ghost mappings retain their sender.

Live proof: native test record `owner-native-text-1789483392508.json` confirmed an actual
ECHOECHO reply before closing the native connection. Beeper then showed exactly two
matching messages: one owner-authored message with `isSender=true` and one ECHO reply.
The same result survived a normal service restart. The original five Beeper outbox
requests remained ACKED with no new requests or rejections, and the journal had zero
pending changes. This proves encrypted owner rendering and no resend loop for this
direct-text path. It does not retroactively change old ghost-authored messages.

Follow-up reply proof: `owner-reply-test-1789483706890.json` records a Beeper reply to
the imported native owner message. Exactly one outbox request reached ACKED. Both the
native outgoing message and ECHO reply reference the expected native quote target;
Beeper shows one sent message and one incoming reply. No restart was needed, and the
journal has zero pending changes. Total Beeper-originated acknowledged tests are now six.

### Superseded investigation: separate owner device

**Release decision:** owner projection remains disabled. The full live path fails
beyond crypto initialization: the owner's global `/joined_rooms` lookup returns
401, and after restoring only verified bridged rooms, owner room-state and key
requests also return 401. Thus successful whoami/native initialization does not
establish usable encrypted owner delivery. The reduced text bridge was restored.

The code now stages guarded same-device session renewal: only an explicit HTTP 401
`M_UNKNOWN_TOKEN` may trigger login; both login and subsequent whoami must match the
configured owner/device before the encrypted token is replaced. Other errors and
identity mismatches leave credentials intact. Owner room restoration uses the bot's
owned-room list with explicit owner membership checks; read-only room state is scoped
to verified portals. These safeguards are available to the owner capability, but the
reduced launcher does not request that capability.

A single authorized native ECHOECHO test was used. Its unsent owner projection was
removed only after verifying its exact message/body/room, no prior mapping, no root,
and no encrypted operation. The stopped stores were backed up first. The native message
and journal entry were retained for normal import through the existing ghost sender.
No test messages were sent to real contacts. Future work must resolve authorization
for the complete owner crypto/event path before enabling this capability again.
After restoration, that test has a normal ghost mapping and is visible in Beeper;
the journal has zero pending changes. It is not shown as sent by the owner. No echo
reply was observed for this native probe, so it is not an additional round-trip pass.

An isolated live initialization now succeeds. Using an encrypted copy of only the
existing owner device, a freshly renewed same-device token, the real framework Bridge
and `prepareOwnerEncryption` produced `crypto.isReady === true`. Request tracing showed
the expected sequence: AS whoami 200, device PUT 404, then three whoami requests using
the renewed token returning 200. The normal bridge stayed running throughout. This
proves native owner-device initialization is compatible with Beeper when supplied a
valid session; it does not yet prove encrypted owner-message delivery.

Additional controls: a renewed token remained valid through 61 seconds without service
restart and worked through both fetch and the bot SDK. The owner's stored device differs
from the bot's. The persisted rejected token still exactly matches the earlier renewal
record, ruling out local token replacement in that attempt. Earlier claims that startup
invalidates the token remain a temporal observation, not an established cause. Next work
is guarded same-device session recovery and integration, with ECHOECHO projection and
restart verification before enabling the feature in the normal launcher.

Follow-up live checks narrowed the failure: the persisted token returns HTTP 401
`M_UNKNOWN_TOKEN`, while its stored device matches `ownerBridgeDevice`. An explicit
appservice login for that exact device returned HTTP 200, and the new token's whoami
verified both owner and device. Installing it in encrypted metadata while the service
was stopped did not fix startup: verification failed again, and a subsequent direct
whoami rejected the saved token. No crypto device or key material was reset.

A separate isolated probe rules out the SDK's initial device PUT as sufficient cause:
renewal and whoami passed, the same-device PUT using owner impersonation returned 404,
and the renewed token still passed whoami afterward. The remaining investigation must
trace token persistence and the other startup requests, rather than assume that PUT
invalidates the token. The normal reduced launcher remains restored with owner projection
disabled; the successful login alone is not an end-to-end messaging result.

The reduced launcher does not enable `getOwnerIntent`. A live read-only whoami
request with the appservice token and configured owner returned HTTP 200 and the
expected owner identity. However, temporarily initializing `matrix.ownerIntent()`
before runtime startup failed: the SDK could not verify the persisted owner
appservice session (`Intent.js`, stored-token verification branch). This does not
establish whether that token is expired, its device differs, or another identity
check failed; the SDK wraps the underlying error.

The enabling change was withdrawn to restore the working text service. No saved
owner credentials or crypto devices were reset. Encrypted bridge stores were backed
up while stopped before the experiment. Four focused owner-encryption, journal-sink
and startup tests plus TypeScript passed, but synthetic tests do not prove live
owner-device compatibility.

Next: inspect the persisted bridge-owned session with a read-only identity request,
report only status and identity/device match booleans, and establish why verification
fails before changing credentials. Then verify a new phone-originated ECHOECHO text
appears as the owner, survives restart, and does not loop back to Threema. Existing
ghost events must retain their original sender. The sections below are historical
implementation notes; their launcher-wiring claims do not describe the reduced release.

The current session intentionally permits only the bot and profile-scoped ghosts. That means
phone-originated changes to a message originally sent from Beeper cannot yet converge: its
Matrix root event belongs to the configured owner, while MessageDelivery requires the sender
of an edit to match the stored root sender. `reconcileOutboundEcho` rejects unrecognized edits
instead of incorrectly acknowledging the canonical update.

## Evidence and integration path

The pinned bridge-manager source already configures owner impersonation with its appservice
token. In `.local/sources/bridge-manager/bridgeconfig/bridgev2.tpl.yaml`, `double_puppet.servers`
uses `BeeperDomain: HungryAddress` and `double_puppet.secrets` uses `as_token:ASToken`. Thus a
separate daily-client token is not the first integration path to pursue. This is source evidence
for Beeper's supplied bridge configuration, not proof that this bridge's registration has the
same server-side authorization.

The Matrix application-service specification scopes identity assertion to registered user
namespaces. The mautrix documentation describes non-exclusive registration for real-user
identities, keeping it separate from exclusive ghost namespaces:

- https://spec.matrix.org/v1.9/application-service-api/#identity-assertion
- https://docs.mau.fi/bridges/general/double-puppeting.html#automatically

Do not widen this project's ghost namespace or pretend that locally adding a namespace grants
server-side permission. The existing registration parser's prohibition on exclusively claiming
the owner must remain. An owner client must verify its authenticated user through the configured
homeserver and use its own persistent bridge crypto device, never share a daily-client device.

## Required implementation and verification

1. Add an explicit owner-identity capability to the Matrix session. Scope it to the single
   configured owner and configured homeserver; retain existing restrictions on generic getIntent.
   Verify authenticated identity before exposing the capability. Do not auto-register, leave rooms,
   or change account profile data through this capability.
2. Integrate the owner client with protected appservice storage, room-state tracking, encrypted
   transaction decoding and shutdown. Prove native crypto device/key persistence through restart
   and separation from bot and ghost devices using synthetic fixtures.
3. Add a canonical owner-edit delivery path for existing owner mappings. Preserve the root event,
   durable projection and transaction IDs, reply relation and media descriptors. Distinguish
   already-known Matrix edit echoes from genuinely new phone changes; never turn these generated
   Matrix events back into outgoing Threema sends.
4. Preserve old ghost-root sender mappings when owner delivery becomes available. New phone
   messages may use the owner; existing ghost events still require that ghost for later edits.
5. Test interrupted encrypted sends, replay after restart, permission revocation, owner/profile
   mismatch, phone edits arriving before original-send acknowledgement, and subsequent Beeper
   edits/deletes of the same root. Owner read receipts and account-data synchronization should
   reuse this capability rather than creating a second identity path.
6. Verify Beeper-specific authorization and encrypted owner events in the live compatibility gate.
   Synthetic fixtures alone cannot establish this server capability.

This work is incomplete. No live owner identity request has been made.

## Dedicated device preparation

`src/matrix/owner-encryption.ts` now verifies the configured owner through the supplied client's
whoami response before marking that existing user registered. It persists a random bridge device
identifier before invoking SDK encryption setup with that explicit identifier. This avoids the
SDK's default search for an existing keyless device, which is inappropriate for a daily account.
A conflicting protected crypto device is rejected rather than reset, and final whoami must match
both owner and bridge device.

The regression uses real protected appservice storage and a synthetic identity transport. It
checks wrong-user rejection before initialization, restart after interrupted setup, retained
device identity, and refusal to overwrite conflicting crypto ownership. It does not yet exercise
native owner encryption or expose an owner capability from MatrixSession; those are next.

A second regression now runs the actual framework Bridge, bot-SDK Intent and native crypto
against a synthetic HTTP boundary. It rejects unexpected requests (including user registration
and device enumeration), forces the application-service-login fallback, and closes/reopens both
the framework and protected storage. The saved access token is reused without a second login;
both the bridge device ID and native Ed25519 identity remain identical across restart. The first
uploaded signing key matches that native identity. Both owner tests and root TypeScript pass.
`pnpm run test:owner-encryption` runs the tests explicitly, and Linux staging includes the test.
Fresh Linux execution and integration with MatrixSession's owner capability remain outstanding.

## Matrix session owner capability

MatrixSession now accepts an optional configured owner and exposes `ownerIntent()` separately
from `getIntent`. Generic intent access still rejects the owner. Configuration rejects an owner
that equals the bot, is a profile ghost, or is exclusively claimed by the registration. Owner
initialization is lazy and shared across concurrent requests, and uses dedicated device
preparation. It registers the resulting client with room-state tracking and the session's
native transaction client set. Shutdown waits for initialization and closes owner crypto along
with other clients. Failed initialization remains failed for that session rather than repeatedly
creating device state.

The returned wrapper exposes identity, client access and a readiness check, without generic
Intent registration/join/leave operations. It is an internal capability; underlying client access
is still trusted implementation code, not a security boundary for untrusted plugins. The normal
launcher does not yet configure or consume the owner capability. Canonical owner-edit delivery
and loop suppression must be integrated before it is used by the production message sink.

The expanded native Matrix-session regression passes (30.81 seconds), proving shared owner
initialization, unchanged generic intent restrictions, rejection after close, and identical
owner device/signing key after session restart without another owner login. The two dedicated
owner-encryption tests and root TypeScript also pass. Transport remains synthetic.

## Suppressing reflected Matrix events

MatrixSession now filters exact persisted encrypted-operation content from timeline events before
native decryption/inbox emission. Crypto extensions in the same transaction are still processed.
The match includes sender, room and all encrypted-content fields; it does not trust a plaintext
bridge marker. PortalStore adds an index over sender, room and Megolm session to narrow candidate
lookup. Existing operation rows supply the evidence, including rows without a returned event ID,
so an echo arriving before the HTTP send response or after a lost response cannot loop back.
Suppression does not mark the send complete or replace its normal transaction-ID retry.

The encrypted-sender regression covers pending-send matching, persistence through restart,
foreign sender/room, changed sender key and changed ciphertext. Native-session regression also
feeds an encrypted event backed by a pending stored operation and checks that it emits no inbox
event while leaving the send acknowledgement absent. Owner-edit projection itself is still
pending; this closes the loop-suppression prerequisite.

Validation: encrypted-sender, native Matrix-session, read-only database doctor and encrypted
backup/restore regressions all pass, as does root TypeScript. Linux execution remains pending
for the owner capability and echo filter.

## Phone text projection

The outbound echo reconciler now accepts an explicit owner-text-projection capability. With it,
a canonical text change that is not a known Matrix edit echo binds/retains the owner root and
returns control to MessageDelivery. MatrixJournalSink can receive a separate owner-intent
provider and selects it only for outbound messages already mapped to the owner; existing ghost
roots retain their original sender. Sender identity and reply-target checks remain enforced.
Once an owner projection exists, a phone revert to the original text also needs a replacement;
it is no longer mistaken for the initial send echo.

The SQLCipher regression preserves a pending edit across restart, retries the same projection,
retains the owner/root mapping, deduplicates unchanged phone content, projects a revert, and
rejects changed reply targets. The test uses the real MessageDelivery with a synthetic sender,
so it does not prove the complete sink-to-owner-encryption path. The existing outbound-echo
regression and root TypeScript also pass. Media-caption owner edits, fresh phone-message owner
projection and production runtime wiring remain outstanding.

## Journal sink and service wiring

ProfileRuntime now forwards the owner-intent provider to MatrixJournalSink. For an outbound
owner-mapped text projection, the sink checks current portal encryption, ownership marker and
owner membership before requesting the owner client and again afterward. The expanded journal
regression revokes membership during client initialization and verifies no send occurs. It then
simulates a lost owner send response, reopens the real journals/stores, and verifies exactly one
ciphertext encryption and one Matrix transaction. The delivered replacement retains the owner
root; a subsequent phone revert also uses the owner identity. Crypto transport is synthetic in
this regression; the separate native owner/session tests exercise actual encryption initialization.

The service launcher configures and initializes the owner capability before starting transaction
processing, and passes it to the runtime. This ensures the restored owner crypto client is present
for incoming device updates. Owner initialization failure prevents startup; it never falls back
to editing an owner event as a ghost. Eight focused journal/runtime/startup/projection tests and
root TypeScript pass. This code has not been run against a live account or reverified in fresh
Linux images. Native end-to-end encrypted owner-edit delivery, media caption edits, newly imported
phone messages as owner, and remaining handoff behaviors are still outstanding.

## Newly imported phone messages and existing senders

For a canonical outbound message without an existing mapping or pending projection, the sink
now selects the configured owner capability. Existing mappings retain their sender, including
legacy profile-self ghosts. Pending projections also retain their stored sender, preventing an
upgrade between encrypted send and mapping commit from changing the projection identity.

The journal-sink regression now leaves a ghost phone-message send pending, enables owner support,
then verifies its retry and later edit stay with the ghost. A distinct new phone message is sent
as owner, and its subsequent edit references that owner's original root. These paths share the
fresh owner authorization checks and durable encrypted sender. The sink regression and root
TypeScript pass. Transport in the sink test remains synthetic; owner media and complete native
cross-device delivery still require broader verification.

## Preserving original attachments during caption edits

`createOwnerMediaRenderer` prepares caption replacements using the verified encrypted Matrix
root instead of rendering/uploading the canonical Threema media again. It snapshots the native
message, requires an owner mapping, checks that mapping again after retrieval, and validates the
returned event's room, sender, root, encrypted status and message type. Attachment descriptors,
thumbnail/info metadata and reply relations are retained; caption text and filename fallback are
updated, and stale formatted caption fields are removed.

The protected-store regression checks descriptor/thumbnail/reply preservation, empty-caption
fallback, unchanged source content, foreign/missing original rejection, and inbound-message
rejection before retrieval. The test and root TypeScript pass. This helper is staged for Linux
but not yet wired into echo admission or MessageDelivery. Canonical attachment identity checks
must remain in the outbound echo reconciler when enabling that path.

## Caption admission and runtime wiring

The media echo reconciler now has a separate owner-caption capability. It permits an unknown
caption or a revert only for native file/image/video content, while retaining the canonical
filename, MIME, size, geometry, duration, thumbnail and reply checks. Known Matrix-edit echoes
remain suppressed. Native audio captions are not admitted; audio projected as a generic file
can use the file-caption path.

MatrixJournalSink uses a separate owner MessageDelivery renderer: media associated with an
outbound Matrix request reuses its verified original descriptor; newly imported phone media
uses the normal backend renderer. ProfileRuntime forwards that renderer, and startService
constructs it using the authorized Matrix original-event loader and service lifetime signal.

The full journal-sink regression projects a phone file caption and its removal under the owner
identity, preserves the original encrypted descriptor and root, and fails if the normal media
renderer tries to transfer that attachment again. Image echo regression explicitly enables owner
caption support and still rejects changed filename, MIME, size, dimensions, thumbnail MIME and
native kind. Focused image/video/audio, renderer, runtime and startup checks pass; root TypeScript
passes. Fresh Linux and full native encrypted caption round trips remain unverified.

## Linux owner-delivery verification

Fresh v53 service images use context SHA-256
`9741ca946fad1791b44f1506183415005a64233dab39ece3340e9248f77f832c`.
Both ARM64 and emulated AMD64 pass the 14-test owner-delivery suite, 49-test mutation suite and
explicit test-runner regression, with no skips. These suite counts overlap in Matrix-session
and runtime tests; they are not 64 distinct tests. Owner delivery took 31.53 seconds on ARM64
and 34.84 seconds on emulated AMD64.

- ARM64 `threema-beeper-service:owner-v53-arm64`, image SHA-256
  `0ded9b3487b39dfe4c85510150b63134d3c1f4e56d9bceb9fc31af0030a330b8`.
- AMD64 `threema-beeper-service:owner-v53-amd64`, image SHA-256
  `ef6d156adac66ff2f3ddca23d4f12d7de9dadead02d03f218774827fa26bc917`.

Each ran `pnpm run test:owner-delivery && pnpm run test:mutations && pnpm run test:test-files`
with network disabled, root filesystem read-only, all capabilities dropped, no-new-privileges,
768 MiB memory and a private temporary filesystem owned by UID/GID 1000. Logs are in
`.local/linux-owner-v53-*-test.log`. The checks cover synthetic native owner initialization and
restart plus the journal/sender projection paths; a complete native encrypted owner-edit round
trip and real Beeper compatibility remain outstanding.

## Mixed Beeper/phone edit convergence

A new regression exposed a suppression bug: after projecting a phone edit, a later phone change
back to an earlier applied Beeper edit's text matched the historical mutation journal and was
incorrectly consumed without updating Matrix. The same ambiguity applied to captions.

After an owner projection exists, canonical content now reaches MessageDelivery's current
projection-digest comparison even when it matches an old Beeper mutation. Unchanged projected
content is still deduplicated. Before any owner projection, known Beeper mutation echoes retain
the existing suppression behavior. This favors current-state convergence; a new Beeper edit
following a phone projection may receive an additional equivalent owner replacement until its
Matrix source event is incorporated into projection tracking.

The text regression first reproduced the failure, then passed with the fix. The full journal-sink
regression also checks a file caption returning to an earlier applied Beeper caption. Four
focused projection/echo tests and root TypeScript pass. v53 Linux evidence predates this fix.

## Native owner replacement round trips and completed echoes

The native owner regression now runs real MessageDelivery and EncryptedSender against the actual
bot SDK/native crypto client. It loses an encrypted text-edit HTTP response, closes and reopens
crypto and portal storage, retries the identical ciphertext/transaction, and sends an encrypted
file-caption replacement. Native decryption verifies both replacement roots and clear bodies,
including preservation of the caption attachment descriptor. The device/signing identity still
survives restart with one login. The HTTP transport is synthetic and room membership contains
only the owner; this does not prove cross-device key exchange or Beeper compatibility.

This test exposed a real loop-suppression gap: completeOperation intentionally clears ciphertext
after recording the returned event ID. Completed echoes therefore cannot rely on ciphertext
matching. PortalStore now recognizes completed events by their recorded event ID together with
sender and room, while pending sends retain exact wire-content matching. A partial index supports
the completed-event lookup. MatrixSession supplies the incoming event ID. No plaintext marker is
trusted, and completed ciphertext need not be retained.

The native owner test checks completed echo recognition after ciphertext cleanup and rejects an
unrelated event ID. Native-session regression separately checks both pre-response and completed
echo suppression. Three native-owner/sender tests and root TypeScript pass; the expanded session
and backup checks are recorded after completion below.

The expanded native-session, read-only database doctor and encrypted backup/restore checks also
pass (three tests, 31.33 seconds). Fresh Linux execution of this completed-echo fix and native
replacement extension remains pending; v53 predates them.

## Cross-device native owner replacements

The owner regression now creates a second native Matrix device for the same synthetic owner,
with independent protected crypto storage and signing identity. The synthetic transport stores
real uploaded device and one-time keys, answers device-key queries and claims, and carries
actual encrypted Olm to-device messages. No session key is injected or exported directly.

The bridge owner device sends text and caption replacements through MessageDelivery and
EncryptedSender. After the sender restart/lost-response retry, the recipient first fails to
decrypt without the shared room key. It then processes the encrypted to-device messages,
closes/reopens its own protected storage, and decrypts both replacements successfully. Assertions
verify replacement roots, text, attachment descriptor, distinct signing identities, at least one
native key claim and encrypted key-share message, and durable echo recognition.

Both owner tests and root TypeScript pass. This replaces the earlier owner-only decryption limit
for this fixture. Homeserver HTTP remains synthetic; server authorization, Beeper client behavior,
network delivery and Linux execution of the expanded test are still unverified.

## Combined Linux event suite

Fresh v54 context `6dc10d08f32d947c28742d45af8098ed1e8d443854de609b4e2acf6dadcebb1f`
passes `pnpm run test:bridge-events`: 58 tests from 29 distinct files on each architecture,
without skips. ARM64 took 32.31 seconds; emulated AMD64 took 44.37 seconds. This includes the
mixed-edit convergence fix, completed-event echo suppression and second-device native owner
replacement decryption. Containers used the same offline/read-only/768 MiB restrictions as v53.

- ARM64 `threema-beeper-service:events-v54-arm64`, image SHA-256
  `126b9e63884a447829a02f185095671643e758206d9cf486202ce8f4afbe0c31`.
- AMD64 `threema-beeper-service:events-v54-amd64`, image SHA-256
  `9e624f205594ba34bfaddba48877ae077419dfb128ca83990cc0a055da089e29`.

Logs: `.local/linux-events-v54-*-test.log`. No live accounts were used.
