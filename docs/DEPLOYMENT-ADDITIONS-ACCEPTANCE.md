# Personal deployment additions — 2026-09-15

This records the September 15 additions and their original package acceptance
results. Those exported images had 14 critical and 125 high package matches per
image. Subsequent candidate builds and scans are tracked separately in
`VULNERABILITY-SCANNING.md`; this historical result does not describe the current
checkout or approve its runtime. The later maintenance and backup changes still
need a matching rebuilt release. No target-host deployment has been performed.

## Verified behavior

- Photo and file replies completed live ECHOECHO round trips. Each produces one quoted native text followed by one attachment. Native attachments cannot carry the quote themselves; video/voice attachment replies remain unsupported.
- Authenticated recovery status and resync worked against the running service. Retry controls only release definitely unsent work from backoff. Unknown sends remain held, with phone-check guidance.
- Unsupported polls/payloads produce phone guidance. Location notices preserve coordinates/map links. Chat topics explain the call limitation; incoming calls may only appear on the phone.
- Both the rounded-square sidebar icon and the small chat badges look correct. The empty duplicate sidebar shortcut is hidden. This uses local Beeper Desktop CSS.

## Outage finding and fix

Live testing exposed loss when the old proxy responded with an error while the local bridge was unavailable. Disconnecting instead fixed a short outage, but a longer test showed remote transaction ranges being replayed after their message payload had expired. The final proxy therefore encrypts and persists received transactions before acknowledging them, then retries local delivery using stable payload-derived transaction IDs.

The final ECHOECHO fixture was submitted at 18:50:23 UTC. The bridge remained stopped, and the proxy was restarted while its encrypted queue retained the transaction. The bridge started successfully at 18:59:30 UTC: more than nine minutes after submission. The message delivered automatically, with exactly one native outbound message and one incoming echo, one Beeper echo, and an empty transaction queue afterward. Recovery status had no pending items and local health reported connected.

Two earlier failed test fixtures were recovered manually through the normal authenticated ingress using their original encrypted Matrix events. They are not counted as automatic-recovery successes.

This proves recovery for transactions received by the proxy during a local service outage and retained across a proxy restart. It does not prove delivery of messages never received during a whole-host/network outage, which still depends on remote retention.

## Automated and package checks

| Check | Result |
|---|---|
| Bridge-event regression suite | 65 passed |
| Daily-feature suite | 46 passed |
| Deployment-addition suite | 9 passed |
| Final Linux amd64 package tests | 28 passed |
| Final Linux arm64 package tests | 28 passed |
| Patched proxy Go tests | Passed: status, real WebSocket failure/success, encrypted restart persistence, stable retry IDs, exclusive ownership, wrong key and corruption |
| Source TypeScript checks | Passed |
| Final image inspection | Passed for both architectures, including proxy hashes and native dependencies |
| Existing-profile migration rehearsal | Offline Linux doctor reported zero failures; copied profile was never connected |
| Backup host-script lifecycle | Stubbed Docker success/failure paths passed for initially running and stopped services |
| Compose configuration | Validated |
| Compose process restrictions | Both architectures passed parent/child zero core limits, refusal to raise the hard limit, non-root UID, zero effective capabilities, no-new-privileges and read-only root checks |

The Linux tests ran with networking disabled, a read-only root filesystem and UID 1000. They include encrypted backup/store restore tests. The 100-cycle recovery test is simulated; it is not 100 live outages. Images were tested in Docker on the Mac, with amd64 emulation; they have not been tested on a target Linux host.

Reproduce the additional deployment restriction checks with `node tests/entry.container-security.ts arm64` and `node tests/entry.container-security.ts amd64`. They reuse the normalized Compose service restrictions in temporary one-shot containers, replacing account mounts, networking and startup with a synthetic probe. They do not connect a linked profile or deliberately crash the live service.

Final build context SHA-256: `a7a304f17353457f50d276cfa73a27274d3c460fcb010c4445de2ab5788dfc73`.

| Image | ID |
|---|---|
| `threema-beeper-service:amd64` | `sha256:ed059114d3b377794e514620a11e4c00698927eda8bfe8c96181f52c68c4e834` |
| `threema-beeper-service:arm64` | `sha256:821bce910795bddc39f71f48f5b457b53c765d3063218f086ea6a1f516c58605` |

The current images include snapshot-page batching, bounded native history selection, the optional heartbeat command, aggregate conversation-byte limits and strict recovery-action validation. Heartbeat tests include real TLS rejection, redirect refusal and the ten-second request deadline on container loopback. The 30,000-call default validator campaign also passed inside each image. Package tests include the compiled native reader's 100,000-model page-selection case. Tests were mounted read-only; application/native runtime code came from the images. The standalone source-only heap test was run on the host, since the image ships its compiled implementation rather than that source module. Performance measurements of the preceding performance-build images are documented in [reconciliation performance](RECONCILIATION-PERFORMANCE.md), with their original immutable image IDs. They were not remeasured for these monitoring/validation images.

## Deployment handoff

[The deployment guide](LINUX-DEPLOYMENT.md) covers migration without relinking, configuration, automatic startup, persistent storage, recovery controls, encrypted backups, scheduling and rollback. Image exports and deployment companion files are under `.local/releases/`; they contain no account installation.

For the actual move, capture a fresh installation after stopping both Mac processes. The rehearsal copy is stale. Start only one copy of the linked profile, then verify ECHOECHO and the first scheduled backup on the server. Multi-day unattended use, whole-host/network outages and target restore/rollback acceptance remain deployment follow-up work.
