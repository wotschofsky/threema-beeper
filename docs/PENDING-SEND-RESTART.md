# Locally accepted sends after restart

The native conversation controller inserts the local message and schedules its
outgoing task without awaiting completion of that task. The bridge's `SENT` state
records that local call returning. It is not, on its own, proof that an upload or
recipient send completed. Native task-manager persistence explicitly transfers
tasks across connection-manager replacement; it does not establish process
restart recovery.

Startup recovery now changes unconfirmed text `SENT` rows to `OUTCOME_UNKNOWN`.
For attachments, it does the same when any recorded message part lacks confirmed
transport evidence. Confirmed text `ACKED` rows and fully observed attachments
remain complete. The change never makes an uncertain request dispatchable again.

The existing failure-notice worker can therefore tell the owner to check Threema
on their phone instead of leaving a locally accepted send indefinitely outside
its uncertainty reporting. An uncertain predecessor blocks later sends in the
same chat; confirmation resolves it and permits that chat to continue. Other
chats with no uncertain predecessors remain eligible.

The regression closes and reopens the encrypted outbox before recovery. Both text
and attachment cases failed before the fix, remained uncertain after a local-only
echo with the fix, and resolved after an upstream timestamp appeared. A further
reopen verifies confirmed rows remain complete. Existing SIGKILL tests cover
text, four attachment classes, attachment replies, and encrypted status retries;
their locally accepted fixtures now expect uncertainty unless they observed a
confirmed echo. Failure-notice tests include a locally accepted row recovered
after reopen and verify stable notices without exposing the original message.

This is a bridge recovery-state correction, not proof that the native task is
resumed. Native upload/task termination acceptance is still open. Historical
rows prematurely marked `ACKED` or observed by older versions are not repaired by
this change. Quote companions also still need separate durable distinction
between local acceptance and confirmed transport for startup recovery. The
existing transport-generation images and live Mac service do not yet include
this subsequent correction.

All 36 focused tests passed on macOS, Linux ARM64, and Linux AMD64 (emulated).
Linux used the verified transport images with changed source and tests mounted
read-only, no network, and no account data. TypeScript checking passed.
[Verification record](PENDING-SEND-RESTART.json) identifies source and log hashes.

The subsequent [quote confirmation correction](QUOTE-CONFIRMATION-RECOVERY.md)
addresses the separate quote-companion startup gap described above. Both changes
still need packaging and live rollout.
