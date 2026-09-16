# Reduced-scope acceptance record

**2026-09-15 expansion:** Groups and photos/files, video and voice are now enabled on the Mac. Four attachment round trips passed; the tested group has its own picture. See [current groups/media acceptance](GROUPS-AND-MEDIA-ACCEPTANCE.md). The text-only record below is historical.

The immediate release was reduced to one linked profile and direct-message text/replies.
The full-product handoff remains deferred. This record covers the reduced product only.

**Core checks pass:** 47 personal-import tests, targeted local-status tests, root/headless type
checks, live ECHOECHO text and quote delivery, saved-profile restarts, and the documented startup
command. Longer-running daily use, a fresh installation and portable Linux operation are not
accepted by these checks.

| Criterion | Observed evidence |
|---|---|
| Saved account and pairing | Existing Beeper registration and linked Threema identity reopen without pairing again |
| Text from Beeper through Threema and back | Six Beeper-originated ECHO-only sends are ACKED; fresh plain/reply tests returned in approximately 3–7 seconds |
| New outgoing Threema text displays as sent | Native ECHOECHO round trip imported as one owner/isSender message and one incoming reply; preserved after restart with no extra outbox requests |
| Send quoted replies | Both an ordinary reply and a reply to an imported owner message produced acknowledged native sends with the expected Threema quote targets and ECHO replies |
| Receive quoted replies | Escaped upstream quote-format ECHO probe produced the expected native incoming quote ID and matching desktop inReplyToID |
| Restart without resending | Saved profile reopened repeatedly; the same five acknowledged sends remain, with no additional requests or rejections |
| Correct room routing | Room creation uses appservice credentials while encryption retains device sessions; SDK regression and ECHO round trips pass |
| Direct chats without owner invitations | Repaired regular/channel rooms have owner membership join and are reported as writable direct chats on the correct account |
| Contacts do not become empty chats | Metadata alone creates no portal; remaining empty legacy mappings were verified and retired without creating rooms or deleting messages |
| Old duplicate rooms | Three obsolete rooms are archived; old messages remain in archived history, separate from replacement rooms |
| Clean active queues | Obsolete manual ECHO diagnostic was preserved in encrypted backup and retired under exact guards; live service queues now wait instead of retrying it |
| Account status | Approved patched proxy runs with --bridge-status; local account state is connected |
| Sidebar branding | Network name and supplied icon are saved in Beeper's derived Threema sidebar entry after refresh; creation and existing-room repair are covered by regression tests |
| Contact pictures | Native getter and bounded worker transport supply JPEG/PNG pictures only for actual chats; a live direct room, ghost and Desktop image URL match the imported media |
| Supported launcher | pnpm start with the existing private config reached service-started in approximately 4 seconds; private diagnostic launcher is stopped |
| Operator health command | pnpm run status reports running/connected with fresh authenticated local state; no message is sent |
| Local health checks | Doctor reports zero failed local checks: permissions, disk, registration and database unlock pass; remote checks remain explicitly unknown |
| Deferred features remain off | Reduced runtime tests cover exclusion of groups, media, mutations, reactions and typing |

Automated messages were sent only to ECHOECHO, never to real contacts. The quote-format probe is a controlled protocol test, not
a claim that a real contact has replied with a quote. The first probe's Markdown conversion did
not exercise incoming quotes; only the escaped second probe supplied that evidence.

## Known limits

- Pre-link phone history is unavailable in the linked profile. Replaced-room history is retained
  separately in archived rooms and is not merged into active rooms.
- The sidebar entry is branded Threema; internal registration/bot IDs and account-settings
  platform branding retain the existing self-hosted identifiers. Pictures require a supported
  JPEG/PNG in the linked profile; phone address-book-only pictures may be unavailable.
- Older outgoing messages imported as the self ghost retain that sender. New outgoing text
  uses the owner identity, verified with a native ECHOECHO exchange and restart.
- Groups, media, edits, deletions, reactions, receipts, typing and calls remain outside this release.
- The Mac, bridge process and proxy must keep running. Login-start and automatic updates are not installed.
- Long-running recovery, fresh-machine setup and portable Linux release acceptance remain.

Use [FIRST-RUN.md](FIRST-RUN.md) for the existing installation's commands and
[CURRENT-STATUS.md](CURRENT-STATUS.md) for technical evidence. The user-facing feature summary
is in the repository README.
