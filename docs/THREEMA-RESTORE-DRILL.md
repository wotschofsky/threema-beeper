# Offline native Threema restore check

The authenticated pre-upgrade backup passed native keystore and database checks
on Mac, Linux ARM64 and Linux AMD64. [Evidence](THREEMA-RESTORE-DRILL.json) records
the exact images, probe source, diagnostic bundle and result hashes.

Use an **offline adopted restore**, never a running profile. In an already prepared
source checkout with the pinned upstream dependencies and native libraries built:

```sh
node scripts/entry.build-restore-probe.mjs
node scripts/entry.verify-restored-profile.ts /absolute/path/to/restored-installation
```

The installation must contain `bridge.yaml`, `secrets/threema-profile`, and its
restored `data/profiles` directory. No password is passed on the command line.
The build creates `build/restore-probe/restore-probe.cjs` under the local upstream
Desktop tree; it leaves the service's `build/headless-spike` bundle untouched.

The verifier copies the keystore, native database and existing SQLite sidecars
to a private temporary directory. It checks wrong-password rejection, opens with
the stored password, compares the configured identity, runs upstream database
migrations and integrity checks, closes, and repeats the successful open. It then
checks that the original selected files are byte-identical and removes the scratch
directory. Output contains only result flags and architecture.

For Linux, use the matching native runtime image with networking disabled, a
read-only root and installation mount, all capabilities dropped, and a private
scratch tmpfs owned by the selected UID/GID. Mount the verifier into `/probe/scripts/`
and the diagnostic bundle at its matching `/probe/.local/sources/threema-desktop/
apps/desktop/build/restore-probe/restore-probe.cjs` path. The native dependencies
must come from the image being tested. The recorded runs used these constraints.

The probe opens storage factories directly, not the backend or connection manager.
Profiles requiring an online remote-secret policy check are rejected. This does
not verify all media, full message contents, target-host startup, migration rollback
or connectivity. It complements the bridge database and Matrix crypto restore
checks; it does not replace deployment acceptance on the actual host.
