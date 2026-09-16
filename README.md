# Threema ↔ Beeper bridge

A self-hosted bridge that brings Threema conversations into Beeper. It runs headlessly,
uses the upstream Threema Desktop protocol implementation, and connects to Beeper
through a Matrix application service and an outgoing `bbctl` WebSocket connection.
You need a Threema account and a Beeper account.

**Experimental software.** The main messaging features work, but long outage recovery,
unattended operation and release security checks are not fully verified. Keep Threema
on your phone available. There is no claim of an approved production release.

## Supported features

| Feature | Support |
| --- | --- |
| Direct messages and existing groups | Text in both directions, including phone-originated messages |
| Quoted text replies | Supported, with fallback when the original is unavailable |
| Photos, files, video and audio | Both directions, subject to size and format limits |
| Photo/file replies | A quoted text message followed by the attachment |
| Reactions, edits and deletion | Supported within Threema's capability and time limits |
| Read receipts | Supported when enabled; privacy settings apply |
| Contacts and group metadata | Names, available pictures and membership synchronization |
| Conversation creation | Available conversations appear without manual invitation acceptance |
| Recovery | Persistent queues, reconnect backoff, failure notices and recovery commands |
| Backups | Encrypted backup/restore and retention tooling |

## Known limitations

- **History:** linking does not import the phone's entire existing chat history. The
  bridge synchronizes messages available in the linked profile; pre-link history may be absent.
- **Groups:** creating groups or managing membership from Beeper is not supported.
- **Attachment replies:** photo/file replies create two Threema messages. Quoted video
  and voice attachments are not supported.
- **Other message types:** typing indicators, polls, locations and calls are not supported.
  Recognized unsupported messages direct you to Threema on your phone; locations can
  retain a map link. Incoming calls may only appear on the phone.
- **Media:** large, malformed or unusual formats can be rejected or fall back to a file.
- **Uncertain sends:** a send that may already have happened is held for reconciliation,
  never automatically resent. Check the phone before sending again. Interrupted native
  uploads and older confirmation records still need further recovery verification.
- **Appearance:** Beeper controls sidebar shapes and message badges. An optional
  [Desktop CSS workaround](docs/BEEPER-APPEARANCE.md) is local to that client.
- **Operations:** full-host outages, target-host reboot/restore, and a multi-week canary
  remain unverified. Dependency review and complete release source/provenance work remain open.
  Updates are manual.

The bridge decrypts messages to translate between networks: this is encryption between
clients and the bridge, not uninterrupted end-to-end encryption across both services.
Protect the machine, configuration, linked profile and backups accordingly.

## Setup

### 1. Obtain a matching image and tools

The intended deployment is **Docker Compose on 64-bit Linux**, using AMD64 or ARM64.
No public HTTP port, domain or reverse proxy is required. Beeper Desktop does not need
to run on the server.

[Container CI](docs/CONTAINER-CI.md) builds both architectures, runs offline package/media
checks and scans, and publishes to GHCR only after its checks pass. The workflow still
needs its first hosted run; do not assume an image is already available. Use an image
from a verified successful run, or build from source using the
[building guide](docs/BUILDING.md). A plain `docker build .` is not sufficient: the
pinned native dependencies and build context must be prepared first.

### 2. Connect your accounts

Follow [first-time account setup](docs/FIRST-RUN.md) from a prepared source checkout:

1. Log into Beeper with `bbctl` and save the custom bridge registration privately.
2. Generate the bridge configuration using your Threema ID and the registration's
   owner, homeserver and domain values; initialize the Matrix encryption key.
3. Run the local setup page, scan its QR code in Threema, compare the emojis and
   save the recovery secret.
4. Start the service with the patched status-reporting proxy and check its status.

For a remote setup page, use SSH forwarding rather than exposing it publicly.
An existing linked installation should be migrated using its backup and credentials,
not registered or paired again. Never run two copies of the same linked profile.

The sample configuration disables optional features by default. Enable the desired
`groups`, `media`, `reactions`, `mutations` and `receipts` flags after setup.

### 3. Run with Docker Compose

Follow [Linux deployment](docs/LINUX-DEPLOYMENT.md) to prepare the private installation,
select the matching image and platform, and arrange persistent storage. Once that
installation and the Compose files are in place:

```sh
docker compose config --quiet
docker compose up -d
docker compose exec bridge node src/service/entry.status.ts /installation/bridge.yaml
```

The container runs as UID/GID 1000 with a read-only root filesystem. Configuration and
secrets are mounted read-only; profile and bridge databases use persistent storage.
Compose restarts the service after failures and host reboots when Docker starts at boot.
A failed healthcheck alone does not trigger a restart.

Before relying on the deployment, verify delivery in both directions, a restart and an
[encrypted backup/restore](docs/BACKUP-RESTORE.md). Configure the backup timer and
independent outage monitoring described in the deployment guide. Store a recovery key
and encrypted backup copy away from the server.

## Development and repository layout

Use Node 24, pnpm 11.15.1 and the pinned build tools described in [BUILDING.md](docs/BUILDING.md).
Start with `pnpm install --frozen-lockfile --ignore-scripts`, then prepare the upstream
dependencies as described in the building guide. After preparation:

```sh
pnpm run typecheck
pnpm run version --json
pnpm run status /absolute/path/bridge.yaml
```

| Directory | Contents |
| --- | --- |
| `src/` | Bridge runtime, setup, storage, media and recovery |
| `integrations/` | Pinned Threema and Matrix overlays and patches |
| `native/` | Native build recipes, patches and dependency locks |
| `deploy/` | Compose, Dockerfiles and host maintenance scripts |
| `scripts/` | Build, verification and packaging tools |
| `tests/` | Automated tests, fixtures and isolated compatibility probes |
| `docs/` | Setup guides, architecture decisions and dated verification records |
| `.github/workflows/` | Native AMD64/ARM64 container CI |

Generated builds, upstream clones, private planning notes and local evidence stay under
ignored `.local/`. Credentials, profiles, logs and backups must not be committed or
included in an image. Dated verification records describe the specific build tested;
they do not prove that every later revision passed the same acceptance checks.

## License

Project code is licensed under the [MIT License](LICENSE.txt). Upstream components retain their
own licenses; see [license and source notes](docs/BRIDGE-LICENSES.md).
