# Current Docker deployment

These Docker images include the latest pending-send, quoted-attachment and retained-history
recovery fixes. Its source commit, exact Docker image IDs and test results are in
`LINUX-CURRENT-VERIFICATION.json`. The bundle's `release.json` and `SHA256SUMS`
identify the archives. The files contain no personal account installation.

Use the ARM64 archive for linux/arm64, or the AMD64 archive for linux/amd64. Check `uname -m` on the destination. For continuous
daily use, use whichever host already has reliable uptime and backups; no public
ports are needed for the bridge.

The downloads are saved Docker images (`docker load`) plus a Compose configuration,
not Debian packages or a separate application installer. The bridge runs in Docker.

## Start with Docker Compose

1. Install Docker Engine and the Compose plugin on the destination.
2. Verify the transferred bundle with `sha256sum -c SHA256SUMS`.
3. Extract `deployment.tar.gz`. Copy `deployment/deploy/` into `/srv/threema-beeper`
   and the matching `deployment/.env.arm64` or `.env.amd64` to that directory as `.env`.
4. Stop the macOS test host bridge, create a fresh encrypted backup, and prepare a Linux
   installation using the existing account. Follow the **Prepare the existing
   installation for migration** section of `LINUX-DEPLOYMENT.md`. Transfer it
   privately as `/srv/threema-beeper/installation`. Do not relink either account
   or run the macOS test host and server copies together.
5. Load the matching image archive and start the service:

```sh
docker load -i /path/to/threema-beeper-amd64.tar.gz
cd /srv/threema-beeper
sudo chown -R 1000:1000 installation
sudo chmod 700 installation installation/data installation/secrets
docker compose config --quiet
docker compose up -d
docker compose exec bridge node src/service/entry.status.ts /installation/bridge.yaml
```

Use the ARM64 archive in the first command for ARM64. The `.env` file pins the
exact image ID. Docker must be enabled at boot. The supplied Compose configuration
restarts the service after process failures and host reboots and stores account
data outside the container. A failed healthcheck alone does not restart it.

The existing Beeper login, registration, room keys and linked Threema profile
move with the private installation. The server connects to Beeper using its
outgoing WebSocket proxy; Beeper Desktop and its API token are not required there.

## Backups and recovery

Use the encrypted backup commands, `backup.sh`, and systemd timer instructions in
`LINUX-DEPLOYMENT.md`. Keep the backup key separately and copy encrypted backups
off the machine. The backup script briefly stops and restarts the bridge to
capture consistent state. Configuration and secrets live in the persistent
`installation` directory, not in the image.

The current outbox schema is 17. An older binary cannot reopen it. To roll back,
use the backup made before upgrading; do not start a stale duplicate profile.

## What still needs acceptance

- The destination host has not been installed or tested. Verify an ECHOECHO round
  trip, a reboot, and a backup/restore on the chosen host before retiring the macOS test host.
- Long offline/native-upload crash recovery and a multi-week unattended run remain
  unproven. Uncertain sends are held and reported rather than automatically resent.
- Dependency findings, full source-distribution completeness, signing and the full
  original release checklist remain open. This is an unverified Docker deployment bundle, not a
  claim that all production acceptance gates passed.
- `application-source.tar.gz` contains tracked project source only. It does not
  claim to be the complete corresponding source for all bundled dependencies.

The older `entry.export-linux-candidate.ts` exporter still defaults to the historical
migration generation. Use this bundle's own manifest rather than regenerating an
older candidate by accident.
