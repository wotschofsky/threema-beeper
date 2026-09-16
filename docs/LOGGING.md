# Service lifecycle logging

The service entrypoint emits newline-delimited JSON for configuration, startup,
shutdown and local resync requests. Each record includes timestamp, component,
build, local profile alias, operation, result, typed error, duration and an audit
flag. Configuration rejection is an audit event. Startup success means the
processing loop has started; `/readyz` remains the readiness authority.

The vocabulary is closed: there is no free-form message or raw exception field.
Remote identifiers, tokens, configuration paths and SDK errors are not passed to
this logger. The SDK logger remains suppressed. Failure records use stderr;
normal lifecycle records use stdout. The development build field is explicitly
`development`; final release stamping is still outstanding. The profile alias is
`primary`, reflecting one configured profile per service process, not a remote ID.

The host or container log collector owns retention and rotation. This does not
complete the handoff's full logging/audit requirements: component-level events,
link/revoke/password/migration/deletion audits and release build IDs remain to be
integrated. Setup and diagnostic CLI output retain their existing formats.

## Local setup audit events

The standalone setup CLI writes structured audit JSON to stderr for link start,
profile-secret persistence, link readiness, recovery acknowledgement, link failure,
cancellation/interruption and removal of an owned incomplete profile. Event
payloads contain only fixed categories, timestamps and local aliases. They never
contain setup state payloads, QR URIs, emojis, identity, paths or secret values.
The intentional one-time local setup URL remains interactive stdout output; it is
not an audit record and should not be collected as an ordinary service log.

LinkSession exposes an optional audit observer so alternate local setup hosts can
attach their own sink. Observer errors do not interrupt credential persistence or
profile cleanup; audit delivery is best-effort, not a durable audit journal.
Revoke, existing-profile deletion, password failure and migration events remain
pending with their corresponding operator flows.
