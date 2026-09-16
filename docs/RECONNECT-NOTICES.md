# Repeated connection failure notices

`src/operations/reconnect-policy.ts` implements the detection policy for the
remaining operational alert requirement. It requests attention after either
three distinct connected-to-disconnected transitions within ten minutes, or ten
continuous minutes offline. The initial disconnected snapshot does not count as
a reconnect. Repeated disconnected observations do not inflate the count.

Once active, an incident retains its revision through continued flapping or a
prolonged outage. Ten minutes of observed stable connection re-arms the policy;
a later incident gets a new revision. State is bounded to three transition times
and small scalar fields, serializable, and validated before reuse. A wall-clock
rollback resets duration evidence without re-arming an active incident.

Four deterministic tests cover rapid losses, duplicate events, initial prolonged
outage, sustained recovery, widely separated interruptions, persisted-state
round trips, rollback and invalid state. TypeScript checks pass.

The service now connects the policy to the backend connection subscription,
independently of typing indicators. The existing management loop also samples
the last observed connection state periodically, so a continuously offline
connection can trigger without another event. Intentional shutdown disconnects
are ignored. Startup fails if the required backend subscription is unavailable.

`ReconnectNotices` saves changed policy state before delivering a warning through
the existing owner-authorized encrypted sender. Notice IDs derive from owner and
incident revision; the fixed notice body is unchanged after recovery, so a lost
response or restart retries the same encrypted operation. Delivery acknowledgements
remain in the portal store. Recovery does not erase an undelivered incident. Like
other maintenance notices, this retains the latest incident rather than a full
history of every interruption.

State lives in `data/maintenance/reconnect/state.json`, contains no message text,
and is read with a 2 KiB bound. Writes use private files, atomic rename and
file/directory sync under the service's existing profile ownership. The single
management pump serializes writes; this is not a multi-writer administrative API.
Corrupt saved state is rejected rather than silently resetting incident IDs.
Only semantic changes write the file; ordinary timer ticks do not fsync every
second. An event arriving during a save is retained for the next drain. A process
crash before that next save can lose recent transition evidence, but notification
attempts never precede durable incident state.

On restart, the previous incident revision is retained, while continuous
connection/outage duration is measured anew; process downtime is not counted as
observed network outage. Known recent disconnect timestamps remain available for
the bounded reconnect window. Ten observed stable minutes re-arm an active
incident. The notification is still subject to Matrix connectivity and room
authorization; external dead-man monitoring remains necessary when the bridge
cannot send its own warning.

Eighteen combined policy/notifier/runtime/startup tests pass on the host, along
with TypeScript checks. They cover bounded state, private persistence, restart,
response loss, recovery, authorization/storage failures, concurrent event arrival,
periodic duration checks, connection subscription with typing disabled, and clean
shutdown. Linux package integration is verified below;
live encrypted notice acceptance remains open. No running account service was changed.
Typed protocol/update and dropped-device notices are now integrated separately;
see `CONNECTION-ISSUES.md`. Arbitrary unclassified upstream failures still rely
on generic reconnect warnings and local diagnostics.

## Linux package verification (2026-09-16)

Both rebuilt service images now include this implementation and pass 86 package/
backend checks plus 13 codec checks each. Native inspection also passes. Exact
image/input identities and hashed logs are in `LINUX-ALERTS-VERIFICATION.json`.
These are offline tests without source overlays or account mounts. AMD64 uses
emulation. Fresh inventory and scan indexes now describe these alert-enabled images.
The refreshed `.local/releases-alerts-20260916` candidate contains these images
and matching host scripts; checksums and Docker loading are verified. Live encrypted
notice acceptance remains open.
