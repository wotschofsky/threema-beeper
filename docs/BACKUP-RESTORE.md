# Backup and restore implementation status

The handoff requires one versioned consistent set containing the closed Threema
profile, bridge databases and Matrix crypto state, encrypted backup storage,
retention and periodic isolated restore drills. This workflow is not yet complete.
Do not treat the archive crypto helper as a usable backup command.

`src/backup/archive-crypto.ts` provides streaming archive encryption using AES-256-GCM
and a caller-supplied separate 32-byte backup key. Format version 1 contains the
8-byte `TBBKUP01` header, a random 12-byte nonce, ciphertext and a 16-byte tag. The
header and nonce are authenticated as additional data. No archive contents or
keys are printed.

Encryption and decryption write private temporary files beneath an existing
private owned destination directory. Complete output is synchronized and published
atomically without replacing existing destinations. Decryption publishes only
after the full tag is verified. On ordinary failure the temporary file is removed.
Abrupt process termination may leave a private temporary file, including plaintext
during restore; the eventual operator workflow must handle this explicitly.
Callers retain ownership of key buffers and must wipe them after use.

Tests cover chunked and empty round trips, modified headers/nonces/ciphertext/tags,
truncation, wrong keys, source errors, cleanup and destination preservation.
Consistent snapshot capture, archive path validation/extraction, source manifests,
key-file handling, restore publication, scheduling and retention remain pending.

## Consistent staging snapshot

`captureSnapshot` acquires the same profile and bridge coordination locks as the
service before creating a fresh private destination. It refuses a busy lock and
keeps both locks throughout copying. It copies the Threema profile, per-profile
bridge state (including Matrix crypto), configured recovery secrets, registration
and optional explicit proxy credentials. Coordination-lock files and Finder
metadata are excluded. Runtime media scratch space is not captured.

Only real regular files and directories are accepted; symlinks and multiply linked
files are rejected. Copying is streamed, each output file is synchronized, and a
versioned manifest records relative paths, original modes, byte counts and SHA-256
hashes. File changes during copying fail the attempt. On ordinary failure the
newly created destination is removed and both locks are released. Existing
destinations are never removed or replaced.

This staging directory contains plaintext unlock secrets and identifying manifest
metadata, even though database files are already encrypted. It must remain private
and be encrypted and removed by the backup orchestrator, which is not yet wired.
The locks coordinate bridge processes; they do not exclude unrelated tools or
administrators writing files. Crash cleanup, source/build provenance, archive
assembly and authenticated restore into a fresh installation remain outstanding.

## Snapshot-to-encrypted-archive orchestration

`createBackup` captures a snapshot into an owned private temporary directory,
streams a portable tar archive through the authenticated encryption helper, then
removes staging on success or ordinary failure. It never starts or stops a service;
busy profile locks cause failure. Destination publication remains no-overwrite.
The caller supplies the independent backup key. No operator CLI or key-file flow
is connected yet.

The root package pins `tar` 7.5.21 with transitive versions and archive integrity
recorded in `pnpm-lock.yaml`. Install it with `pnpm install --frozen-lockfile --ignore-scripts`.
Linux staging verifies the installed version and includes its runtime dependency
closure, while excluding packages used only by native build tools. A synthetic
cross-version check creates an encrypted backup with 7.5.16 and restores it with
7.5.21; the archive format and backup compatibility metadata are unchanged.
Run `node tests/entry.tar-upgrade-compat.ts /absolute/path/to/old/tar` with a retained
7.5.16 installation to reproduce this check. Broader release provenance remains
unfinished; see `VULNERABILITY-SCANNING.md` for candidate versus exported images.

An end-to-end synthetic test captures the private set, encrypts it, authenticates
and decrypts it, and lists the archive to verify expected state/recovery files and
absence of lock files. This is not yet a safe extraction/restore or live-profile
drill. Crash cleanup and the remaining operator workflow are still outstanding.

## Authenticated restore workspace

`restoreBackup` reserves a new private destination directory and authenticates the
encrypted archive before extracting into its `state/` subdirectory. It validates
the tar inventory first: only ordinary files/directories under the fixed snapshot
roots are allowed; links, traversal, duplicate entries, Unicode/case collisions,
missing directory parents and unsupported types are rejected. Current bounds are
one million entries, 100 GiB declared content and a 16 MiB manifest.

After extraction it checks manifest identity syntax, file inventory, byte counts
and every file hash, requires the recovery files, and applies private modes.
Authentication or validation failure removes only the newly reserved workspace.
An existing destination is never replaced. The authenticated temporary tar is
removed on success. Abrupt termination may leave private incomplete plaintext
staging; the workspace must not be used until the function returns successfully.

This restores a validated snapshot workspace, not a running installation. Mapping
its paths into a new service configuration, verifying real encrypted-store reopen,
source/schema compatibility, durable publication, operator CLI and scheduled
restore drills remain unfinished. Tests restore a synthetic large-file backup and
reject wrong keys, existing destinations, symlink entries and modified file data.

## Encrypted bridge-store restore drill

`pnpm run test:backup-store-drill` creates the actual four SQLCipher-backed bridge
stores with synthetic data, refuses backup while they are locked, closes them,
backs up and restores, then reopens the restored set in a separate installation.
It verifies healthy store access, preserved inbox work, the same derived Matrix
key and unchanged interrupted outbox state. Startup recovery changes that state to
`OUTCOME_UNKNOWN`, and it cannot be claimed for automatic retransmission.

This test exercises real bridge-store encryption and backup file handling, but
uses a synthetic Threema profile directory and registration. It does not establish
upstream linked-profile recovery, native Matrix room-key recovery, successful
account reconnection or automatic restore deployment. The test performs explicit
path mapping into the new installation; a production adoption command is still
pending.

## Local operator commands

With Node 24 and installed root dependencies, create an independent backup key in
an existing private directory:

```sh
pnpm run backup init-key /private/secrets/backup-key
pnpm run backup create /private/bridge.yaml /private/secrets/backup-key /private/backups/new-backup.enc
pnpm run backup restore /private/backups/new-backup.enc /private/secrets/backup-key /private/restore-workspace
```

These are example paths; all parent directories must exist and satisfy private
ownership/permission checks. Close the service before creating a backup. The
command refuses busy profile locks and never stops a running instance itself.
Keys are mode-0400 files, never argv/environment secret values. Initialization
never replaces a key. Creation rejects reuse of either store unlock key, even if
copied to another filename. Keep the backup key outside captured profile/bridge
trees and retain a separate protected recovery copy.

Successful restore produces a validated workspace, not an active installation.
Do not start another linked instance from it while the original is running.
Failures return exit 1 with a fixed message; invalid arguments return 2. Existing
destinations are never replaced. Process crashes can leave private staging files;
scheduling, crash cleanup, retention and automatic adoption remain unfinished.

The bridge-store drill now additionally initializes a real native Matrix
`OlmMachine` under the captured Matrix directory, creates a Megolm session and
encrypts a synthetic room message before closing the machine and taking the
backup. After restore it verifies the same device identity and decrypts that
pre-backup message from the restored native store. This tests native identity and
room-session persistence through the full archive flow. It still does not prove
live account reconnection, full appservice bot/ghost routing after restore or
upstream Threema linked-profile recovery.

## Upstream source compatibility

Snapshot manifest version 2 records the names, URLs and commits from the installed
source-pin manifest. Restore requires the same sorted upstream set before it
accepts file contents. A mismatch fails and removes the new restore workspace.
The encrypted envelope remains format version 1. Earlier development snapshot
manifests without compatibility metadata are now rejected rather than guessed.
No migration path for those unpublished fixtures is provided.

This check does not establish bridge-code release identity, database schema
compatibility or migration safety; those require additional release provenance
and schema-aware upgrade tooling. In particular, matching upstream commits alone
is not permission to run a different bridge revision against restored data.

## Restore completion record

Restore now synchronizes every verified file after applying its private mode,
then synchronizes directories from children to parents. It removes the plaintext
tar and publishes `RESTORE-COMPLETE.json` from a fully written and synchronized
temporary file, then synchronizes the workspace and its parent. The record contains
the manifest hash and verified file count. A missing record identifies an
unfinished workspace; consumers must also parse it and verify its manifest hash,
not merely check that a filename exists.

These are OS/filesystem synchronization guarantees, not a power-loss hardware
certification. No crash-injection campaign has yet been run for this restore path.
A completion record does not establish schema compatibility or authorize startup;
those adoption checks remain pending.

## Recheck a restored workspace

```sh
pnpm run backup verify /private/restore-workspace
```

This read-only check requires the completion record, matching manifest hash and
upstream source set, private owned real paths, exact file inventory and every
recorded file hash/size. It rejects extra files, missing files, links and modified
contents without reading a backup key or starting accounts. It does not decrypt
message rows. Verification fails with a fixed diagnostic and exit 1.

The completion record and manifest are consistency metadata, not signatures. A
party who can rewrite both can forge them; the encrypted archive's authentication
is the trust boundary during restore. This command detects accidental changes and
incomplete workspaces, not a malicious administrator. Passing verification does
not establish live service/schema compatibility or authorize adoption.

## Check the intended service account

```sh
pnpm run backup verify /private/restore-workspace /private/proposed-bridge.yaml
```

New snapshots record the profile ID, Threema identity, Matrix owner/domain/namespace
and homeserver inside their encrypted manifest. Supplying the optional configuration
requires an exact match in addition to file/source verification. A different owner,
identity, namespace or endpoint fails with a fixed diagnostic. It does not print
these identifiers. Paths may differ so an isolated restored installation can use
new storage locations; account routing must remain the same.

Older development snapshots without this binding may still pass the file-only
check but cannot pass configuration-bound verification. This provides an adoption
precondition, not an adoption command or automatic migration of account routing.
Full service/schema compatibility and live reconnection remain separate checks.

## Prepare a fresh service installation

```sh
pnpm run backup adopt /private/restore-workspace /private/proposed-bridge.yaml /private/new-installation
```

Adoption verifies the workspace against the intended account binding, reserves a
new private installation directory, copies and re-verifies the workspace, and
maps its profile and bridge state into the service layout. Secrets remain local
under the new installation's `secrets/` directory. The generated `bridge.yaml`
contains file references and rewritten data/media/secret paths. It round-trips
through the strict service configuration parser before publication. Existing
installations are never overwritten; ordinary failures remove only the newly
created installation. The original restore workspace remains intact.

For managed proxy configurations, explicit credential data-directory references
are moved to the new installation and revalidated. Executable and WASM paths stay
as supplied in the proposed configuration. Read-only bridge schema access must
pass; no store migration or account startup occurs. Stop the original instance
before running a restored linked account. Native Threema profile validation,
full schema/migration compatibility, crash-durable installation publication and
live reconnection remain outstanding.

The real bridge/native Matrix restore drill now uses this adoption helper rather
than manually copying paths, and parses the generated configuration before store
reopen. Synthetic proxy credential relocation is not yet covered by that drill.

Adoption now requires the current bridge `user_version` values: journal 4, inbox 2,
portals 8 and outbox 2. The check opens stores read-only and refuses older or newer
versions without running migrations. Ordinary doctor still distinguishes basic
key/schema readability from this stricter adoption policy. This gate checks
version declarations, not complete SQL schema equivalence, native-store migration
compatibility or a full upgrade/rollback policy. Version changes require explicit
migration work before adoption can accept them.

## Adoption publication and process-crash tests

Adoption now writes configuration to a private pending file, synchronizes all
installation files/directories, then atomically publishes `bridge.yaml` and
synchronizes the installation and parent directory. The generated startup
configuration is the publication boundary. Before it appears, an interrupted
installation is incomplete and must not be started or silently reused.

The encrypted-store drill SIGKILLs child adoption processes immediately before
and after configuration publication. Before publication no `bridge.yaml` exists;
after publication the configuration parses and the encrypted inbox reopens with
its queued work intact. Both partial and completed destinations reject another
adoption attempt rather than being overwritten. A thrown pre-publication failure
is also tested and removes the owned new directory normally. Abrupt termination
leaves private state for explicit operator inspection/cleanup. These are process
crash tests on the development filesystem, not physical power-loss certification.

Adoption additionally validates the restored appservice registration and performs
managed-proxy preparation before publishing configuration. This checks explicit
credential contents, matching registration files and the pinned executable,
without starting the supervisor. The restore drill now uses synthetic managed
proxy credentials/registration and a deliberately non-executable-content binary;
it verifies relocated data-directory references and unchanged source credentials.
A wrong executable checksum fails and removes the new installation before it is
published. This is local validation, not acceptance of credentials by Beeper.

Outbox schema 3 now persists unsupported-action rejection decisions. Current
adoption therefore requires outbox version 3 (superseding version 2 above).
The normal store constructor migrates v2 by adding the rejection table without
changing accepted requests; read-only adoption does not perform that migration.
