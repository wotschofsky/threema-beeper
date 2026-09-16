# Media process-termination recovery

The synthetic crash test exercises the production `MediaDispatcher`, encrypted SQLCipher
`OutboxStore`/`MediaJournal`, and reopening after a real child-process SIGKILL. It covers
files, images, audio and video through their respective dispatcher routes.

Each media class has ten termination checkpoints:

1. Before request insertion.
2. After durable insertion, before dispatch.
3. During media preparation, before claim.
4. At entry to the backend send adapter, after durable claim and before ID allocation.
5. After durable ID allocation, before any synthetic recipient effect.
6. After the first of two synthetic recipient effects.
7. After both effects, before returning the send result.
8. After reordered echoes arrive, before returning the send result.
9. After the send result is committed, before echo observation.
10. After echo observation following the committed result.

The parent waits for an IPC checkpoint, kills the child, waits for its actual exit,
reopens the store, and replays the same Matrix request. Definitely unclaimed work can
send once. Interrupted claimed work remains uncertain unless durable echoes resolve it;
it is never automatically dispatched again. A separately fsynced ledger represents
the recipient. Its entries must be unique, and absent effects are never invented during
reconciliation. Reordered and repeated echoes must converge without another send.

This is additional evidence for handoff §20.4, not full remote-send acceptance. No live
Threema or Matrix request occurs. The test does not exercise native upload interruption,
codec interruption, encrypted Matrix pending-status delivery, attachment reply companions,
or device revocation. The two-part ledger stresses partial completion but does not claim
that every native attachment generates two messages. The backend adapter is synthetic;
real upstream allocation/echo behavior needs its separate integration evidence.

Linux runs mount only this new test file read-only into the previously verified disk
candidate images. The journal, dispatcher and native database library come from each
image. No account data is mounted, networking is disabled, and writable scratch space
is a private non-executable tmpfs. The test is included in staging for future builds;
the existing exported image archives have not been rebuilt for this test-only addition.

All 40 cases passed on the development host, ARM64 Linux and emulated AMD64 Linux
on 2026-09-16. Exact image IDs, test-file hash and log hashes are in
[the verification record](MEDIA-CRASH-VERIFICATION.json). Root TypeScript checking passed.

The subsequent recovery images include both media and text SIGKILL fixtures. Their
95 package tests and 13 codec tests pass on each architecture without source mounts;
see [packaged recovery verification](LINUX-RECOVERY-VERIFICATION.json). Earlier
source-overlay runs above remain distinct historical evidence.

A separate attachment-reply fixture now checks seven SIGKILL points for photos and
files: before dispatch, quote claim/allocation/effect/result, attachment effect and
attachment result. It uses the real reply resolver, dispatcher and three encrypted
stores with synthetic recipient effects. Uncertain quotes remain visible and block
the attachment; delayed quote confirmation releases only the unclaimed attachment.
Wrong-chat, repeated and reversed echoes do not trigger a duplicate send. All 14
cases passed on Mac, ARM64 Linux and emulated AMD64 Linux. See
[reply crash evidence](MEDIA-REPLY-CRASH-VERIFICATION.json). Linux runs use the
packaged migration runtime with only the new test fixture mounted. This adds
companion coverage for photos/files; native uploads and Matrix pending-status
delivery remain separate acceptance work.

Encrypted sent-status recovery after the result commit now has a separate
[native-crypto crash fixture](STATUS-CRASH-ACCEPTANCE.md), covering five checkpoints
for text and each media class. Native upload interruption and pending UI behavior
remain open; see its scope and limitations rather than treating it as full §20.4 acceptance.
