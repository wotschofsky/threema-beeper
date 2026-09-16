# Storage-capacity warnings

The service samples the filesystem holding `dataDirectory` once per minute through the existing
management maintenance pump. At 20% or less space available to the bridge user, it records an
incident and sends an encrypted, owner-authorized management-room notice. Availability includes
filesystem reservations; it is not a measurement of bridge-owned files alone.

One incident remains active until available space exceeds 25%. This prevents repeated warnings
when usage fluctuates around 80%. A later threshold crossing increments the incident revision.
The private `maintenance/disk/state.json` file contains only that revision and active flag and
is atomically replaced and synced before delivery. It is protected by the service's existing
exclusive profile ownership. The monitor does not delete data or change storage quotas.

Stable notice IDs and fixed message text allow the encrypted sender to retry a lost response
without inventing a new warning. Pending warnings survive restart and can arrive after storage
has recovered; their wording makes that clear. Readiness and management authorization still
apply. No paths, account details or message content are included in the warning.

Tests cover the exact threshold, rearming, sample throttling, clock rollback, persistence before
delivery, offline observation, restart, lost response, corrupt/oversized state, invalid capacity,
storage failure and failed authorization. A real temporary-directory statfs read is also checked.

Limitations: the warning requires a running service, writable incident/Matrix stores and an
available management connection. A full disk can prevent it from being persisted or sent.
External dead-man monitoring remains necessary. Inode exhaustion, separate backup disks and
host-wide filesystem monitoring are not covered by this check. The behavior passes source and rebuilt Linux
package tests on ARM64 and emulated AMD64 (89 package and 13 codec tests per image).
See [image-bound verification](LINUX-DISK-VERIFICATION.json) for exact image IDs, commands,
fixture settings and log hashes. It has not been exercised on the live linked profile.
