# Quoted attachment confirmation across restart

Outbox schema 17 records confirmed transport for the text quote that accompanies
an attachment. A local send return can still release the attachment during the
same session, but it does not set the quote's confirmation flag. Only a matching
confirmed echo sets it. A local-only echo remains suppressed without confirming
delivery.

After restart, an accepted quote with no recorded confirmation becomes uncertain.
An already confirmed quote stays complete and is not sent again. The recovery
list and queue counters expose an uncertain quote even when its attachment has
been independently confirmed. Confirmation of the quote clears that uncertainty
without changing the attachment's state.

The migration runs inside the existing outbox schema transaction. Schema 16 has
no durable way to distinguish an accepted quote from a confirmed quote, so its
existing rows default to unconfirmed. They require confirmed model evidence to
resolve after startup. The migration does not invent confirmation or automatically
resend a quote. Older binaries reject schema 17; rollback must use the backup
from before migration rather than reopening the migrated outbox with older code.

Tests cover file and photo replies after a lost response, a successful local
return, and migration from schema 16. They reopen the encrypted store, check
recovery visibility and counters, reject confirmation from another chat, and
verify confirmed state survives another reopen without another send. A case
confirms the attachment independently before the quote. The process-termination
tests also verify that stopping after the quote's local return blocks the
attachment until quote confirmation, without duplicating either message.

This fixes the bridge's durable quote confirmation. It does not prove that native
Threema upload tasks resume after process termination, and it does not repair old
text or attachment rows that were incorrectly acknowledged by earlier versions.
The running Mac service and transport-generation Linux packages have not yet
been updated with schema 17 or the preceding pending-send startup correction.

All 20 focused checks pass on macOS and both Linux architectures. TypeScript
checking also passed. Linux tests mounted changed source/tests into the verified
transport images with networking disabled and no account data.
[Verification record](QUOTE-CONFIRMATION-RECOVERY.json) records their hashes.
