# Profile ownership and recovery secrets

Every backend worker acquires `ProfileLock` before initializing a profile. It holds an exclusive
SQLite lock on `.bridge-profile-lock.sqlite`. The coordination database is intentionally empty of
identity, credentials and message data; it contains only an empty lock table. Profile data remains
in the upstream encrypted stores. Lock contention produces `profile-in-use`. The file remains in
place when ownership ends; never delete it to break a live lock.

OS file locking releases ownership when the worker or process exits, including SIGKILL. There are no
stale-PID guesses or timeout-based lock stealing. Tests cover separate processes, separate workers,
termination, crash recovery, repeated close and a symlink profile. This coordinates bridge workers;
an unrelated Desktop application does not participate in this lock. Use a dedicated bridge profile,
never the user's existing Desktop profile. Filesystem locking on network volumes has not been
validated; deployment must use a local filesystem.

`src/setup/profile-secret.ts` generates 32 random bytes encoded as base64url for upstream's profile
password. It writes and fsyncs a temporary mode-0400 file, publishes it using an atomic
non-overwriting hard link, then syncs the parent directory. An existing secret is never replaced.
Temporary files are removed on normal failure. A crash can leave an extra temporary hard link inside
the private secret directory; automatic crash cleanup of those files is still pending.

Secret reads refuse symlinks, non-regular files, unexpected permissions, oversized files and
noncanonical recovery values. Values are returned only to the local caller, not put in command-line
arguments or environment variables. Buffer copies are wiped; JavaScript strings cannot be reliably
zeroed. As specified in the handoff, keeping the unlock secret on the same host does not protect
against full host compromise.

Run `pnpm run test:profile` and `pnpm run test:backend-worker` after native dependencies are prepared.
The local setup coordinator now persists the secret before supplying it at waiting-for-password;
see `LOCAL-PAIRING-SETUP.md`. `src/threema/saved-profile.ts` reopens an existing profile with the secret
file, returns its identity and worker, and provides an explicit close operation. Cancellation and
failed opens terminate the worker and release profile ownership. It never falls back to linking.
Missing-identity failure and lock release are tested with the real backend; a successful linked
profile reopen still needs live verification. No live identity was linked by these tests.
