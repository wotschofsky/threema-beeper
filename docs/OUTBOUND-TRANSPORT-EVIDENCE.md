# Local echoes and delivery confirmation

A local Threema model echo proves that a message was inserted into the linked
profile. It does not by itself prove that its upload or upstream send completed.

The previous recovery path changed an `OUTCOME_UNKNOWN` text row to `ACKED` and
removed it from the recovery list when a matching local echo had no `sentAt`,
`deliveredAt` or `readAt`. The isolated reproduction records that behavior in
[the verification record](OUTBOUND-TRANSPORT-EVIDENCE.json).

The bridge now preserves the owner-event mapping but requires at least one of
those upstream timestamps before marking an echo observed. This applies to text
and attachment echoes. An attachment quote companion is still recognized and
suppressed as a separate Matrix message while unconfirmed, but its uncertain
state is retained. A later confirmed echo resolves it normally. The existing
failure-notice path can therefore continue exposing the uncertainty.

Send evidence is not a claim that a recipient has read a message. `sentAt` means
upstream send evidence; delivered/read timestamps remain stronger, separate
statuses. Reactions and mutations retain their own readback logic.

Tests that represent confirmed delivery now include the upstream timestamp.
Regression cases verify local-only text/file echoes keep recovery entries and
stable mappings, confirmed echoes resolve them, and local quote recognition does
not clear uncertainty. The journal integration case distinguishes initial local
insertion from a later delivered status.

This does **not** complete native-upload crash acceptance. In particular, these
changes do not yet determine whether every locally accepted `SENT` task is resumed
after terminating the native backend, or audit legacy rows already acknowledged
by earlier bridge versions. Upstream's persistent task manager explicitly handles
connection-manager replacement; that alone is not evidence of process-restart
recovery. Isolated native task termination and startup reconciliation still need
verification. No retry was added to work around this uncertainty.

## Packaged verification

The fix is now included in locally built ARM64 and AMD64 service images from
commit `25327e9`. Each image passed 106 package tests and 13 codec tests with
networking disabled and no source or account-data mounts. This includes the
attachment-reply and native encrypted-status termination tests. Exact image IDs,
context digest and log hashes are recorded in
[LINUX-TRANSPORT-VERIFICATION.json](LINUX-TRANSPORT-VERIFICATION.json).
[Fresh inventories](LINUX-TRANSPORT-INVENTORY.json) cover these image IDs; they do
not constitute a fresh vulnerability assessment. AMD64 ran under emulation.

The exported migration archives have not been updated. The Mac service
has now been restarted with this fix after an encrypted backup and offline
restore verification. It reconnected and passed one ECHOECHO round trip; see
[LIVE-TRANSPORT-UPGRADE.json](LIVE-TRANSPORT-UPGRADE.json). These checks do not
establish target-host deployment or native Threema upload-task restart recovery.
