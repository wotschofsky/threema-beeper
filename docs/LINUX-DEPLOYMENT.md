# Linux deployment

The service uses an outgoing Beeper WebSocket connection. No public HTTP port, domain, reverse proxy, Beeper Desktop process or Desktop API token is needed. Use 64-bit Linux on AMD64 or ARM64. One linked profile may run on only one machine at a time.

## Package acceptance status

The current Docker deployment bundle is `.local/releases-current-20260916`; follow
[the current Docker guide](CURRENT-PACKAGE.md). Its own `release.json` pins the
image IDs. It includes the combined recovery fixes and outbox schema 17.
The historical full evidence/source candidate remains
`.local/releases-migration-20260916`, recorded in [candidate export](LINUX-CANDIDATE-EXPORT.json).
The package generations have distinct acceptance records:

- Migration images include atomic portal migrations and pass 97 package and 13 codec
  tests per architecture without source mounts. See [migration verification](LINUX-MIGRATION-VERIFICATION.json)
  and [fresh inventories and scans](LINUX-MIGRATION-INVENTORY.json).

- Earlier recovery images include the notice-backlog fix and packaged crash tests.
  Both architectures pass 95 package and 13 codec tests without source mounts; see
  [recovery verification](LINUX-RECOVERY-VERIFICATION.json). Their exported image
  identities, all nine checksums and 79 source/evidence archive entries passed
  read-back verification.

- Earlier storage-warning images include storage-capacity warnings and pass 89 package
  and 13 codec tests per architecture. See [storage-warning package verification](LINUX-DISK-VERIFICATION.json).
  [Fresh inventories and scans](LINUX-DISK-INVENTORY.json) are available for these images.
  Their matching archives passed checksums, Docker config identity, deployment image
  references and all 79 source/evidence archive entries.
- The earlier alerts candidate passes 86 package and 13 codec tests per architecture,
  with image-bound inventories and scans. See [alerts verification](LINUX-ALERTS-VERIFICATION.json)
  and [candidate export](LINUX-CANDIDATE-EXPORT.json).

The exporter below selects the migration candidate by default.
Pass `recovery`, `disk` or `alerts` as its second argument only to reproduce an earlier candidate.
Existing archives remain tied to the image IDs in their own `release.json`;
running the exporter does not alter an earlier export.
Security review, live acceptance and target-host acceptance remain open. Do not
mix host scripts with an older image missing their CLI commands.

A repeatable candidate exporter verifies the input context, test-log hashes,
image identities, inventory/scan hashes and scanner bundles before packaging:

```sh
node scripts/entry.export-linux-candidate.ts .local/new-linux-candidate
```

Run from a clean committed checkout with the prepared local artifacts and Docker.
The destination must be new and under `.local`. The output contains compressed
images, a deployment archive, verification evidence, both Linux scanner bundles,
`release.json` and `SHA256SUMS`. Verify the checksum list before installation.
These are unsigned test candidates, not approved releases. Root planning
files and account installations are excluded. Do not publish the candidate as a
finished release until the remaining acceptance gates are complete.

The deployment archive contains `deployment/deploy/`, `deployment/docs/` and
architecture-specific `.env.amd64`/`.env.arm64` files. Copy the files in `deploy/`
into the installation directory and select the appropriate architecture file as
`.env`. It pins the immutable Docker image ID; loading the candidate archive
makes that ID available without changing the older release tags. Install the
matching scanner bundle as described in `VULNERABILITY-SCANNING.md`.

## Build the Docker images

From the prepared source checkout with Node 24, Go and Docker:

The current recipe also requires the checksum-verified Node source archive in
`.local/node-cleanup-review`, matching `docs/NODE-CLEANUP-BUILD.json`. It compiles
the recorded cleanup-hook backport and runs its native regressions. A first build
can take hours, especially with AMD64 emulation on a Mac; subsequent builds reuse
the matching runtime layers. Full candidate acceptance is still pending.

```sh
pnpm run prepare:status-proxy
pnpm --dir native/runtime-dependencies install --frozen-lockfile --ignore-scripts
node scripts/entry.stage-linux-native.ts .local/linux-release
for arch in amd64 arm64; do
  docker build --platform "linux/$arch" --target service \
    -f deploy/docker/Dockerfile.native \
    -t "threema-beeper-service:$arch" .local/linux-release
  node scripts/entry.inspect-linux-image.ts .local/linux-release "$arch"
done
docker save -o .local/threema-amd64.tar threema-beeper-service:amd64
```

The staging directory must be new. Source/codec preparation prerequisites are in README.md. The status proxy is built from the pinned upstream commit plus the tracked patch; its generated manifest binds architecture and binary SHA-256. Inspection verifies those hashes, native libraries and non-root execution. An ARM64 image tested under Docker on the Mac is not target-host acceptance.

## Prepare the existing installation for migration

Stop the Mac service and proxy gracefully and wait for both to exit. Create an encrypted backup first (`pnpm run backup init-key ...` once, then `backup create`; see below). Do not register another bridge or link Threema again.

From the Mac checkout, with the existing private paths:

```sh
pnpm run prepare:linux-installation \
  '/absolute/existing/bridge.yaml' '/absolute/private/bbctl.json' \
  amd64 '/absolute/private/new-installation'
```

The output parent must be private, owned by you, and the destination must not exist. The tool obtains the same profile locks as the service, captures an encrypted backup, verifies/restores it, preserves the Matrix identity and room keys, and writes Linux paths. It copies the proxy login while removing its Mac Desktop dependency. It never starts the copied profile or changes the original installation. The resulting directory contains secrets: transfer it over SSH, not through a public repository or image registry.

For the actual move, use a fresh capture after stopping the Mac. A rehearsal snapshot becomes stale as soon as the Mac resumes.

## Install on Debian

Install Docker Engine and its Compose plugin using the official Debian instructions: https://docs.docker.com/engine/install/debian/
Enable Docker at boot (`sudo systemctl enable --now docker`). Check `uname -m`: x86_64 uses amd64; aarch64 uses arm64.

Use `threema-beeper-amd64.tar.gz`, `threema-beeper-arm64.tar.gz` and `deployment.tar.gz` from the same chosen candidate output directory. Use the current bundle identified in `CURRENT-PACKAGE.md`; check its image IDs against its own manifest. `LINUX-CANDIDATE-EXPORT.json` describes the older migration candidate. `release.json` records image identities and archive checksums. `LINUX-CANDIDATE-EXPORT.json` records checksum and archived-image validation. The older `.local/releases/` directory is historical. Docker loads the compressed image archive directly.

Create `/srv/threema-beeper` with mode 0700. Securely copy:

- The candidate deployment files, including `compose.yaml` and `backup.sh`, into it.
- The matching generated `.env.amd64` or `.env.arm64` as `.env`.
- The prepared private directory as `/srv/threema-beeper/installation`.
- The matching Docker image archive.

Then, on the server:

```sh
cd /srv/threema-beeper
docker load -i /path/to/threema-beeper-amd64.tar.gz
sudo chown -R 1000:1000 installation
sudo chmod 700 installation installation/data installation/secrets
docker compose config --quiet
docker compose up -d
docker compose exec bridge node src/service/entry.status.ts /installation/bridge.yaml
```

For these candidates, use the generated `.env.arm64` or `.env.amd64` as `.env`; it pins the matching immutable image ID and platform. Service files use fixed container paths under `/installation`; host paths are independent. The container runs as UID/GID 1000, has a read-only root filesystem and no published ports. Profile and bridge stores live in the bind-mounted data directory. Secrets and config are mounted read-only. The proxy is supervised by the bridge, including ongoing account-status reporting and an encrypted durable transaction queue under the bridge profile directory. Received transactions survive local service/proxy restarts. Messages never received during a whole-host/network outage still depend on Beeper retention; test that scenario on the target before treating it as proven.

`restart: unless-stopped` starts the container after host reboots and process failures. A failed healthcheck marks it unhealthy; Docker does not automatically restart a merely unhealthy container. Review status/logs and restart deliberately when needed.

The supplied Compose file sets both soft and hard core-dump limits to zero. Native crashes must not write process memory containing plaintext or keys into a core file. Child processes inherit the limit and cannot raise it. Preserve this setting when adapting the deployment; running the image with unrelated Docker settings does not carry this Compose protection automatically. It does not disable explicit application diagnostics or host-level memory capture.

Verify an ECHOECHO round trip before retiring the Mac installation. Keep the stopped Mac data and pre-migration backup until server acceptance passes. Never start both copies. Once the server has processed messages, rollback requires a fresh stopped-server backup; starting the stale Mac copy risks losing current mappings and queue state.

## Recovery

```sh
docker compose exec bridge node src/service/entry.recover.ts /installation/bridge.yaml status
docker compose exec bridge node src/service/entry.recover.ts /installation/bridge.yaml resync
docker compose exec bridge node src/service/entry.recover.ts /installation/bridge.yaml retry
```

`status` lists pending text/attachment delivery states without message bodies. `resync` requests native reconciliation. `retry` removes backoff only from definitely unsent work. It never resets uncertain sends or generates replacement message IDs. Check the phone before manually resending an uncertain message. Reactions and edits have separate automatic readback recovery. These controls do not provide arbitrary history import or reset a revoked Threema device.

## Encrypted backups

The backup includes the linked profile, bridge databases, encryption keys and (with supervised proxy configured) proxy credentials. Backup keys must be separate from profile/Matrix keys. Store a recovery copy of the backup key separately from the server.

Create a private writable backup directory owned by UID 1000 and a new backup key:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /srv/threema-backups
docker compose run --rm --no-deps -v /srv/threema-backups:/backups \
  --entrypoint node bridge src/backup/entry.backup.ts init-key /backups/key
```

Move the key to a protected location readable by UID 1000, such as `/srv/threema-backup-key`, and retain a separate recovery copy. Run from `/srv/threema-beeper`:

```sh
BACKUP_DIR=/srv/threema-backups BACKUP_KEY=/srv/threema-backup-key sh ./backup.sh
```

The script serializes backups with `flock`, stops the service to capture consistent state, and restarts it afterward if it was running, including on backup failure. Expect a brief connection interruption. After a successful backup it retains the newest 30 recognized archives by default. Set `BACKUP_KEEP=0` to disable pruning, or choose a count from 2 through 3650. Install this script only with an image containing `src/backup/entry.retention.ts` and `src/backup/entry.status.ts`. Copy encrypted archives off the server; local retention is not an off-site backup.

The script records its result under `installation/data/maintenance/backup` after
attempting the restart. Backup, retention and restart failures exit nonzero. When
the bridge is connected, its encrypted management room receives one warning per
failure incident; consecutive failed attempts do not repeat it. A subsequent
successful attempt preserves a warning that has not been delivered yet. A new
failure after success starts a new incident. Successful backups alone create no
chat. Delivery acknowledgements use the encrypted portal store and survive restart.

This is not an independent outage alarm: if Docker cannot run the status command,
storage cannot persist it, the host loses power, the script is force-killed, or
initial configuration/lock setup fails, the in-bridge notice cannot report that
failure. Keep the external dead-man check and inspect failed systemd units.
Result persistence failures also make the backup service fail. The alerts candidate
and newer storage-warning images include this addition;
their package tests cover persisted incident state, lost responses, deduplication,
room authorization, and backup-store restoration. Separate host-script fixtures
cover backup/retention/restart/status-write failures and preserve an already-stopped
bridge. These synthetic checks do not establish that a target host's scheduled
job or live encrypted warning works. Live encrypted delivery and target timer
acceptance remain open.

For daily scheduling, install the supplied `threema-backup.service` and `.timer` into `/etc/systemd/system/`. Put the two absolute environment paths in `/etc/threema-beeper-backup.env` (mode 0600), then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now threema-backup.timer
systemctl list-timers threema-backup.timer
```

## Restore drill and updates

The actual pre-upgrade Mac backup was authenticated, adopted offline, and checked
in both current Linux runtimes with networking disabled. All four bridge databases
passed current-schema and integrity checks, rejected wrong keys and corrupted
scratch copies, and remained byte-identical. See [restore evidence](LINUX-RESTORE-DRILL.json).
A separate [Matrix restore drill](MATRIX-RESTORE-DRILL.json) opened temporary copies
of the existing bot crypto store on Mac and both Linux runtimes: the device fingerprint
and room keys were retained, repeated opening was stable, and wrong passphrases
were rejected. No restored Threema profile was started. Other crypto identities,
old-event decryption, complete host recovery and rollback remain separate checks.
The [native Threema restore drill](THREEMA-RESTORE-DRILL.json) also passed on Mac
and both Linux architectures: wrong-password rejection, expected identity, database
integrity and repeated opening. It used an additional diagnostic bundle and disposable
copies, without starting a backend or connection. See the [repeatable procedure](THREEMA-RESTORE-DRILL.md).

Use a NEW private workspace, mounting the backup/key and workspace into an offline container. Run `src/backup/entry.backup.ts restore <archive> <key> <workspace>`, then `verify <workspace>`. `adopt <workspace> <matching-config> <new-installation>` creates an installation without starting it. Recheck Linux config paths and run doctor before live use. Keep restored copies offline during drills; only one copy may connect.

Before upgrades: stop, create an encrypted backup, load the tested new image, and run `docker compose up -d --force-recreate`. Check status, recovery queues and ECHOECHO afterward. No automatic image updates are configured; database changes need deliberate rollback planning.

## External monitoring

[External monitoring](EXTERNAL-MONITORING.md) provides an optional missing-heartbeat ping and host timer. The current images contain the heartbeat command. Activation requires a configured external endpoint and a verified alert path. It is not enabled automatically.

## Weekly upstream monitoring

[Upstream monitoring](UPSTREAM-MONITORING.md) supplies `upstream-check.sh` and the
`threema-upstream-check.service`/`.timer` files. Install these after loading an
image containing the maintenance commands. State lives under the existing
persistent data mount. The timer does not update dependencies. Changed public
pages or failed checks produce encrypted maintenance notices; ordinary startup
and unchanged checks do not create an extra chat. Follow the guide's activation
and review steps. Weekly security scanning and live notification acceptance are
still separate release requirements.

## Backup retention checks

Retention runs while the host backup lock remains held and only after backup
creation succeeds. It recognizes private owned regular files with the host
script's timestamped names and the bridge archive header. Unrelated files,
symlinks, hard-linked archives and incomplete headers are left alone. The newly
created archive must sort newest; clock reversal or a missing completed backup
stops cleanup. At least two recognized archives are retained. Retained files and
the directory are rechecked for replacement before each deletion, and directory
changes are synced. Manual modification during the backup run is unsupported.

Header recognition is not authentication or a successful restore test. Keep the
separate recovery key and continue periodic restore drills. A cleanup failure is
reported as a failed scheduled job; the previously running bridge is restarted.
Tests use synthetic files only and verify unrelated-file preservation, minimum
retention, missing-newest rejection, and backup/cleanup failure restart behavior.
No existing user backup was deleted during implementation.

Earlier archives passed `docker image load` on the local daemon; that result
does not establish loading the current migration archives on a clean host.
Use the immutable image IDs in the selected archive’s `release.json`. Documents
inside a versioned archive reflect its evidence commit and may describe earlier
package generations. Current archive checks are recorded in
`LINUX-CANDIDATE-EXPORT.json`; target-host acceptance remains open.
