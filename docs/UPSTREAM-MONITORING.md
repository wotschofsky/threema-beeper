# Weekly upstream change check

`src/service/entry.upstream-monitor.ts` checks the public Desktop tag list,
[Desktop changelog](https://threema.com/en/changelog/desktop-md), and
[Terms page](https://threema.com/en/tos). It uses the documented public
[GitHub tags API](https://docs.github.com/en/rest/repos/repos#list-repository-tags)
and does not use bridge credentials or contact data. It never installs updates.

The first successful run establishes a baseline. This does not assess whether
the pinned release is already outdated; review it against the current changelog
when installing. Later checks compare up to 100 tag names and commit IDs and
page hashes. Script/style/comment content and whitespace are ignored in page
comparison. Navigation or layout changes can still trigger review; a page hash
change does not establish a substantive Terms change. Removed or retargeted tags
also trigger review; API ordering alone does not.

Requests have a 20-second timeout, a 2 MiB body limit and reject redirects. A site
move or failed request is reported as unavailable, preserving its previous hash.
The state directory contains only public-source hashes and pending source names.
State is atomically replaced and synced. Concurrent invocations fail rather than
race. An empty SQLite coordination database holds an OS-backed exclusive lock
that is released after a crash or forced kill. Never delete that database to
break a live lock. No linked profile is opened. Parse errors do not silently
reset the baseline. Random temporary filenames avoid collisions after PID reuse.
Stop any older checker process before upgrading from the sentinel-file version;
its legacy `check.lock` is no longer used.

## Run and schedule

Use an image built from source containing this command; the older exported images
predate it. With the existing deployment in `/srv/threema-beeper`, copy
`deploy/upstream-check.sh` there and install the service/timer under
`/etc/systemd/system/`. Then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now threema-upstream-check.timer
sudo systemctl start threema-upstream-check.service
sudo journalctl -u threema-upstream-check.service
```

The timer checks weekly and catches a missed run after startup. The script uses
the running bridge container and the persistent
`installation/data/maintenance/upstream/state.json`. Unchanged successful runs
are silent. Changes and failures emit only fixed source names; failures exit
nonzero. Review the corresponding URLs when `pending` contains `changed`.
Changes remain pending even after subsequent unchanged runs or an outage.

The service now polls this saved state through its existing management loop.
Only an undelivered pending notice creates the encrypted management room. Creation
requests Beeper automatic joining, and an explicit owner join must succeed before
a fresh room authorization check allows sending. Missing state or an unchanged
baseline creates no chat. The existing encrypted sender persists ciphertext and
acknowledgements under stable transaction IDs, so a failed response retries the
same operation and a restart skips acknowledged notices. Revisions distinguish
later changes, including a page reverting to earlier contents.

Saved `pending` changes mean review is still needed, not that notification delivery
is still pending. Delivery acknowledgements live in the encrypted portal store.
The launcher now enables the existing encrypted management commands. Local review acknowledgement is available as described below. Weekly security
scanning and live host acceptance remain unfinished. No timer or live account
notification was activated as part of these implementation tests.

## Verification

`node tests/entry.upstream-monitor.ts` verifies quiet baselines/repeats, retained
changes, HTTP/redirect/body-limit failures, recovery, state validation and stable
tag comparison. A public-endpoint smoke run established all three baselines
without credentials. TypeScript checks passed. Host timer activation and Linux
image inclusion must be verified during release integration.

Notification tests cover lazy room creation, response loss, restart deduplication,
new revisions, authorization failure and readiness loss. Management-room tests
check automatic joining is requested. The startup regression and TypeScript
checks pass; actual encrypted notification delivery still requires live acceptance.

## Linux package verification (2026-09-16)

The first Linux run exposed a missing runtime import:
`integrations/threema/overlay/src/headless/node-typing-request.ts`. Although typing
is disabled, the backend controller imports its validator. Staging now includes
that module and the maintenance regression files. Both AMD64 and ARM64 passed all
13 checks with the corrected staged source/tests mounted read-only into their
Node 24.18.1 candidates; no account data or external networking was available.
The ARM64 service import smoke also passed without opening a profile.

Context: `d912682a244d80ccf2c16086e074f61960de7f92d596d18b7fae4548708ebc13`.
Logs: `.local/linux-maintenance-fixed-{amd64,arm64}.log` and
`.local/linux-maintenance-import-arm64.log`. TypeScript checks passed. These are
source-overlay checks against the existing native runtime candidates, not proof
that newly rebuilt release images or target-host timers have passed acceptance.

The checker CLI also passes a forced-kill recovery test: while a mocked fetch is
pending, a concurrent lock acquisition fails; after SIGKILL the next complete CLI
run succeeds with all three synthetic baselines and no manual lock removal.
This passes on the host and offline ARM64 and AMD64 Linux with the native
coordination library. Linux logs are
`.local/upstream-monitor-restart-linux.log` and
`.local/upstream-monitor-restart-linux-amd64.log`.
It does not start an account session or make real network requests.

## Record a review

From the deployment directory, inspect the pending source names and revisions:

```sh
docker compose exec -T bridge node src/service/entry.upstream-monitor.ts /installation/data/maintenance/upstream status
```

Read the relevant public source above and decide whether the installation needs
an update or should be stopped. Then acknowledge the revision you inspected
(replace `2` with the revision from status):

```sh
docker compose exec -T bridge node src/service/entry.upstream-monitor.ts /installation/data/maintenance/upstream review terms 2
```

Sources are `tags`, `changelog` and `terms`. Review is local administration;
no update is installed and no service authorization is implied. It clears only
that source's pending change, preserving its baseline and revision. If another
check found a newer change, the command refuses the stale revision. Run status
and review the newer result. Failed checks cannot be dismissed as reviewed;
resolve the check failure instead. Retrying a successful review is safe until a
new revision exists. Status and review perform no network requests and share
the monitor's process lock and atomic persistence. They do not delete existing
management-room messages or change their delivery acknowledgements.

Host tests verify stale and repeated review, later changes reopening review,
unchanged checks staying quiet, unavailable-source rejection, persisted state,
and mutual exclusion. The new review command is included in the current maintenance candidates
verified below; exported deployment archives still predate this addition.

## Current maintenance package verification (2026-09-16)

The latest AMD64 and ARM64 service-target candidates include the local review
command, scan persistence, scan notices and weekly host-job files. Both pass all
66 package checks and 13 codec checks. Exact image/input identities and log hashes
are in `LINUX-MAINTENANCE-VERIFICATION.json`. Package checks use executable tmpfs
for temporary host-script stand-ins; codec tests pass with noexec tmpfs, and the
deployment configuration retains noexec. No source overlay, account mount or
external networking was used. AMD64 is emulated. Fresh inventories and scans are now bound to these image IDs in
`SBOM-COVERAGE.json` and `VULNERABILITY-SCAN.json`. Release exports, the real
host schedule and live encrypted notices remain unverified.
