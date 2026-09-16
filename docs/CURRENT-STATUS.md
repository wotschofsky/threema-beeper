# Current implementation status

**2026-09-16 live upgrade:** The Mac service was stopped gracefully, backed up with
the existing independent key, and restarted on current source after authenticating
and restoring the backup into an offline workspace. The new process reports connected
and passed an ECHOECHO round trip (one outgoing message and one reply). See
[live upgrade evidence](LIVE-RECOVERY-UPGRADE.json). This enables the recovery fix
and maintenance code on the Mac; individual alert fault injection and Linux host
acceptance remain open. Earlier live observations below describe the preceding Mac service.

**2026-09-16 live recheck:** The existing Mac service reports connected, and one
authorized ECHOECHO test completed with one outgoing message and one reply visible
in Beeper. See [live evidence](LIVE-ECHO-20260916.json). This did not restart the Mac or establish live acceptance of the newer Linux recovery build.

**2026-09-16 recovery fix:** Failure notices now scan beyond the first 100 text and
100 attachment rows. Stable sequence pages keep batches bounded and cover later
failures without repeating acknowledged notices. Rebuilt ARM64 and AMD64 packages
each pass 95 package tests (including text/media SIGKILL coverage) and 13 codec
tests without source mounts. See [package verification](LINUX-RECOVERY-VERIFICATION.json)
and [pagination regression](FAILURE-NOTICE-PAGINATION.json). The matching archive
`.local/releases-recovery-20260916` passed read-back verification; its fresh inventory
and scan results are in [recovery inventory](LINUX-RECOVERY-INVENTORY.json). The Mac
worker upgrade and basic round trip are recorded above.

**2026-09-16 storage warnings packaged:** Periodic 80% storage warnings use durable, encrypted
management-room notifications with restart deduplication. Rebuilt ARM64 and AMD64 images each
pass 89 package and 13 codec tests; see [image-bound verification](LINUX-DISK-VERIFICATION.json)
and [storage warnings](DISK-NOTICES.md). Live acceptance remains open.
[Fresh inventories and scans](LINUX-DISK-INVENTORY.json) contain the same 341 packages
and 170 advisory matches per image as the preceding candidate. The matching private candidate is
`.local/releases-disk-20260916`: both image archives, deployment files and source supplements
passed read-back verification. See [candidate export](LINUX-CANDIDATE-EXPORT.json).

**Latest: deployment additions verified.** Photo/file replies, durable proxy recovery and Linux packages are complete; see [deployment acceptance](DEPLOYMENT-ADDITIONS-ACCEPTANCE.md). Current image dependency inventories are indexed in [SBOM coverage](SBOM.md); full release security, target-host acceptance and canary remain open.

**Earlier: daily features enabled.** Reactions, edits/deletes, public read receipts and retry backoff are now active. Live test-group and ECHOECHO checks passed; see [daily feature acceptance](DAILY-FEATURES-ACCEPTANCE.md). Earlier records below are historical.

**2026-09-15 expansion:** Groups and photos/files, video and voice are now enabled on the Mac. Four attachment round trips passed; the tested group has its own picture. See [current groups/media acceptance](GROUPS-AND-MEDIA-ACCEPTANCE.md). The text-only record below is historical.

## Latest live verification (2026-09-15, afternoon)

New outbound Threema text now projects under the actual owner identity. The bridge bot
encrypts the message and an owner-scoped appservice client sends it, matching the upstream
bridge pattern. The separate owner crypto device was the wrong integration path for
owner delivery; its initialization alone did not establish delivery compatibility.
A native ECHOECHO round trip is visible as one owner/sent message and one incoming reply,
unchanged after restart. The five existing Beeper outbox sends remained ACKED with no new
requests or rejections, and the journal has no pending changes. Older self-ghost roots retain
their original sender. See [owner identity evidence](OWNER-MATRIX-IDENTITY.md).

The Threema sidebar entry now has its correct name and configured supplied icon. The installed
Beeper renderer uses network.avatarURL/displayName for account-network spaces, while the bridge
previously populated only protocol branding. PortalManager now writes both network fields at
creation and repairs missing fields on verified existing rooms. Existing rooms
were updated consistently. Beeper initially retained stale computedSpaces; after a full app
restart, its saved Threema account-network entry has displayName=Threema and the configured
avatar. The actual room data had already updated before the cache refresh. Four focused
portal/journal tests and root TypeScript pass. Existing internal registration/bot IDs are retained;
this does not claim that Beeper's account-settings platform name or Matrix IDs were renamed.


Contact pictures now flow through a read-only native getter and bounded worker response into
verified existing direct rooms. The getter never creates or looks up remote contacts. JPEG/PNG
pictures up to 2 MiB update the room and contact avatar; a content hash in room state prevents
reuploading unchanged pictures and recovers an interrupted profile update. Missing pictures clear
only a previously bridge-managed picture. Unavailable/unsupported pictures do not stop text.
The live direct room has the imported hash, its ghost profile matches the room avatar,
and Beeper Desktop's image URL references that uploaded media. The channel has no imported
picture; availability is not inferred from a fallback icon. No contact messages were sent.
Native getter/worker tests, projection recovery and the journal's picture-failure regression pass;
root and headless type checks pass and the rebuilt native bundle is running.


The supported `pnpm start <config.yaml>` entrypoint now runs the saved profile, replacing the
private diagnostic launcher. It reached service-started in approximately four seconds.
`pnpm run status <config.yaml>` verifies fresh authenticated local bridge/account states and
reports running/connected without exposing identities or sending a message. Tests cover freshness,
wrong-profile responses, disconnects, redirect refusal and size limits. The full personal-import
suite passes all 45 checks. The local doctor reports zero failed checks; remote compatibility and
connection checks remain explicitly unknown in that offline command. The same five acknowledged
ECHO sends remain after the supported-launcher restart.


Three automated Beeper → Threema → ECHOECHO → Beeper round trips passed. The fresh
plain-text test returned in approximately 7 seconds. A quoted reply after a graceful service
restart returned in approximately 3 seconds; its acknowledged outbox record includes a native
Threema quote target. Two plain sends and one quoted send are ACKED, with no rejections.
No automated messages were sent to real contacts. Incoming quotes were subsequently verified
with an ECHO-only wire-format probe: the native inbound message's quote ID matches an existing
ECHO message, and the desktop's saved inReplyToID matches that message's Matrix event. The first
probe was converted to formatting by Beeper's Markdown input; escaping the quote markers
preserved the wire format and the second probe passed. Total sends are now five ACKED (four
plain-text inputs and one ordinary quoted reply), with no rejections. Restarting afterwards
preserved those five sends and the incoming reply relation. Long-running reliability remains
unverified.

The routing failure was caused by creating rooms with the SDK's device-login credentials.
Beeper's server associates new rooms with the appservice when createRoom uses its registration
token. Crypto still uses per-device clients. Commit 49ae6f6 also handles optional device-list
fields and room-key acknowledgements, prevents a missing key in one room from freezing other
rooms, and preserves the worker-local native controller's receiver during send. Regression
tests and root/headless type checks passed; the headless bundle was rebuilt and is running.

The existing direct and channel conversations have been replaced with rooms created
using appservice credentials. Owner membership is join, Desktop reports writable direct chats,
and the local portal mappings point to the replacements. The stopped encrypted stores were
backed up before repair. Historical message mappings/ciphertexts are retained in their original
rooms. The old rooms have replacement markers. Beeper's archive API returned 200 without
persisting its room account data. Inspection of the installed client confirmed that it consumes
com.beeper.inbox.done with at_order/updated_ts. Setting that account data using each old room's
actual saved message order fixed archiving. Desktop now reports the two old rooms and the old
ECHO diagnostic room archived; replacement rooms remain active and writable. No history was
deleted or merged into replacements. No automated messages were sent to those conversations.

PortalStore.replaceRoom now checks the expected mapping and refuses unfinished delivery.
Replacement preserves message roots and versions across restart. Replies to history in a
different room use the unavailable-target path instead of an invalid cross-room relation.
Five focused portal/projection/journal tests and root TypeScript pass.

Remaining contact-only mappings were verified to have no remote message history, native
history, queued text sends or owner membership/invitation, then retired with the service stopped
and stores backed up. No rooms were created and no messages deleted. Retirement refuses any
local history or pending ciphertext. New room aliases use an appservice generation suffix in
the hash so removed legacy rooms cannot be rediscovered. Five portal/alias/journal tests and
root TypeScript pass. After restart, no empty mappings remain and the same three acknowledged
ECHO sends remain without additional requests.

Remaining immediate work:
- Validate longer-running operation and the user-facing setup/run instructions.
- Pre-link history remains unavailable. Account-settings/internal registration IDs still use
  the existing self-hosted identifier, while the Threema sidebar entry is branded correctly.
- Keep the reduced-scope acceptance limitations below; do not treat a successful ECHO test as
  proof of every feature in the original full handoff.

Ongoing account-status reporting is explicitly approved and running through the patched bbctl
proxy with --bridge-status. The server/Desktop account status is connected. A manually injected
old ECHO diagnostic transaction was preserved in a private encrypted store backup and retired
from active processing. A strict guard matched its manual transaction prefix, exact ECHO event,
old room and sender, with no bundled key updates. No real transaction was discarded. After
restart the service is ready, synchronization is live and transactions report waiting, not retrying. Temporary crypto-routing instrumentation was removed
from the local launcher before the latest restart.

The active target is now the **reduced personal direct-text bridge**.
The original full handoff is deferred. See the repository README for the current feature summary and limitations.

The normal launcher selects textOnly mode: one profile, contact text/replies, encrypted Matrix
rooms, saved identity, local pairing and restart recovery. Group history and media/typing/reaction/
mutation loops are excluded. Larger-feature implementations remain in the repository.

Seventeen focused configuration, synchronization and runtime tests pass after narrowing scope;
root TypeScript passes. Twelve additional sink, unsupported-event, reply, outbox crash and startup tests pass.
The reduced sink skips media/groups without blocking text and does not replay them after restart.
Live acceptance remains.
Beeper Desktop login was reused and sh-threema registration succeeded. The phone linked and
its saved profile reopened successfully. The setup page incorrectly reported a network error;
its terminal-state HTTP lifecycle is now fixed and covered by a reproduced regression. The profile contains contacts but no old
messages, so previous phone conversations cannot currently be imported.

The native group-model clone crash is fixed through a worker-local handle. Native open/link
regressions, headless build/typecheck and live enumeration/topology/directory checks pass.
The initial importer mistook contact-only entries for chats and created 29 empty invitations.
All 29 were verified empty and withdrawn. Only actual supported messages now create portals;
new portals request automatic joining, supported by the live Beeper server. Ghosts are created
only for actual chats. Those obsolete empty mappings were subsequently retired; see the latest verification above.

Beeper's unavailable member-list endpoint is handled using current room state for encryption
recipient discovery. Historical token queries retain their original semantics. The focused
membership and native Matrix session regressions pass. `test:personal-import` collects the
relevant import, native-model, membership and message-path tests.

Current live evidence (2026-09-15): a bot exchange and a regular-chat outbound text have
three encrypted Matrix events and matching durable mappings. The bot chat
appeared after metadata repair. Both actual conversation rooms have owner membership `join`;
zero empty contact invitations remain. Restarting after the bot exchange preserved exactly
two encrypted events, with no duplicate delivery.

The regular-chat report exposed two additional defects:
- Native message collections are weakly cached; delta-only subscriptions retained the event
  controller but allowed the collection itself to be garbage-collected. A real upstream-store
  regression reproduced the loss, then passed after retaining a normal collection subscription
  for the watch lifetime. It also verifies release after stop. Conversation topology retains its
  collection the same way. Headless build/typecheck and root typecheck pass.
- Beeper does not perform its bridge registration processing for `createRoom.initial_state`.
  Merely including both bridge-info event names at creation was insufficient. PortalManager now
  publishes both events after creation/recovery and repairs mapped Beeper rooms lacking server
  recognition. The regular room was repaired in place; the server now marks it self-hosted.
  The room's stored contact name and membership were correct even while the UI showed self/invite.

The 31-check personal import suite passed before these last two fixes; 11 targeted checks pass
after them. The personal import command now also includes the watcher lifetime regression.
Earlier checks used no automated contact messages; the later ECHOECHO-only tests supersede that restriction.
Remaining live acceptance: ordinary post-fix message arrival without restart, regular-chat UI
name/invitation display, decrypted messages, Beeper-to-Threema sending and quoted replies.
Sidebar branding remains generic in this Beeper version, with no supported override found.
The separate self-chat creation time is unknown: owner-wide enumeration was rejected.


User policy: no conversation invitation/request feature. Imported chats always set
`channel.com.beeper.message_request=false`, and new rooms auto-join the owner. Recovery of a
private room uses an internal membership event marked `fi.mau.will_auto_accept` and
`com.beeper.exclude_from_timeline`, then joins automatically; never wait for user acceptance.
Both existing message-bearing rooms were updated and read back with request=false.
Five targeted regressions and root typecheck pass after this change. The preceding full
personal-import suite passed 32 checks, including watcher GC lifetime and portal metadata.


Beeper duplicate-display investigation: the desktop index has exactly one thread row for
the regular conversation, assigned to sh-threema with the correct title and isReadOnly=false.
The displayed self/read-only copy therefore appears to be stale client state after bridge
classification changed. Beeper was gracefully quit and reopened; no Matrix room was deleted.
Visual confirmation remains pending. Contact photo import is absent from node-directory and
ghost synchronization, so the bridge icon fallback is an acknowledged reduced-scope limitation.
The saved bbctl production login authenticates owner read-only Matrix requests successfully;
the earlier owner enumeration failure applied to the appservice token, not this saved login.


Setup invitations: all 15 remaining Threema bridge invitations were revoked; both joined
conversations were retained. The reduced launcher no longer starts the optional management
chat bot, preventing further setup-room invitations on restart. In-chat management commands
are unavailable in this version; local setup and service tools remain available.
