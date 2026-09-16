# Typed connection compatibility issues

Pinned Desktop code reports unsupported protocol versions and dropped-device
conditions through its `SystemDialogService`. The former headless implementation
threw for every dialog, so these conditions could fail in the frontend adapter
instead of reaching an operational notice.

The adapter now recognizes only these upstream categories:

- `client-update-required`
- `mediator-update-required`
- `client-was-dropped`
- `device-slot-state-mismatch`
- `device-protocols-incompatible`

Known categories produce a dismissed dialog handle and a typed event. No update,
reconnect, credential reset, deletion or relinking is confirmed. In the pinned
upstream connection manager, dismissal of the local mediator-version dialog
keeps auto-connect disabled; remote client-version failures and dropped devices
retain upstream's own disable behavior. Other dialogs remain unsupported. Raw
server text, URLs, work credentials and arbitrary dialog context are never sent
across the event boundary.

The callback passes through the Node session, backend worker and validated
`BackendController.onConnectionIssue` callback. Unknown worker codes are ignored;
a throwing observer does not strand backend requests. The added session argument
is optional so existing callers remain compatible.

Validation: the headless Vite bundle built successfully, eight combined boundary,
backend lifecycle and service-startup tests passed, and project TypeScript checks
passed. Tests use synthetic data and temporary profiles; no live account was
opened. Upstream source copies were updated only after comparing the installed
overlays to their previous tracked versions; the running service was not restarted.

Typed events are now connected to durable incident state and the encrypted
management sender. The journal loads under the service's exclusive profile
ownership before the backend opens, so startup-time events are not missed.
Writes begin when events arrive, coalesce without an unbounded queue, and retry
through the maintenance loop after storage failure. Shutdown stops the backend
and flushes the journal before releasing bridge stores. An unsuccessful startup
can preserve a pending notice even though it cannot deliver through Matrix yet.

State is bounded to the five known categories and contains only revisions and
active flags. It lives in `data/maintenance/connection-issues/state.json`, with
private atomic file replacement and file/directory sync. Reads reject invalid or
oversized state rather than resetting it. The journal exposes only durably saved
snapshots to notification delivery. Repeated reports of an active category stay
quiet; a successful observed connection re-arms categories for later incidents.
Recovery preserves an undelivered revision.

Each fixed notice explains the category and recommends local review or phone
checks. No raw upstream dialog text is used. Owner/category/revision-based IDs
reuse the encrypted sender's persisted acknowledgements, so response loss and
restart retry the same content. Neither notices nor recovery flags alter upstream
connection behavior or automatically update, relink or reset a profile.

Twenty combined compatibility-boundary, journal/notifier, reconnect, runtime and
startup tests pass, along with TypeScript checks. They cover durable private
storage, repetition, reopening, recovery, corrupt/oversized state, lost responses,
storage failure retries and authorization failure. No account messages were sent.
Linux packages are verified below; live encrypted notification acceptance remains open.
A crash before a pending file write commits may still lose that newest event;
whole-process/host failure requires external monitoring.

## Linux package verification (2026-09-16)

Both rebuilt service images now include this implementation and pass 86 package/
backend checks plus 13 codec checks each. Native inspection also passes. Exact
image/input identities and hashed logs are in `LINUX-ALERTS-VERIFICATION.json`.
These are offline tests without source overlays or account mounts. AMD64 uses
emulation. Fresh inventory and scan indexes now describe these alert-enabled images.
The refreshed `.local/releases-alerts-20260916` candidate contains these images
and matching host scripts; checksums and Docker loading are verified. Live encrypted
notice acceptance remains open.
