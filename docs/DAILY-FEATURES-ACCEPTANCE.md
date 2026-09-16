# Personal daily features — 2026-09-15

Reactions, edits/deletions, public read receipts and reconnect recovery are enabled alongside existing groups and media. The test installation keeps its existing Threema profile, Matrix encryption state and WebSocket status proxy.

## Live acceptance

Automated traffic was limited to ECHOECHO and a dedicated test group. No other conversations received automated tests.

- Test group: a Beeper text appeared in the native Threema journal; its edit reached `APPLIED` and changed native text; its deletion reached `APPLIED` and produced a native tombstone.
- Test group: a second test message received a thumbs-up in the native model. Removing it in Beeper produced a settled withdrawal and removed the native reaction.
- ECHOECHO: fresh text and its bot reply appeared in Beeper. Reading the reply completed the durable owner receipt and updated native `readAt`, with the Matrix owner cutoff saved.
- ECHOECHO rejected editing with `mutation-unsupported`. The bridge retained that explicit outcome and delivered a failure notice; it did not bypass native capability policy.
- Connection remained healthy across service restarts. Unknown sends were not reset or resent.

## Implementation and regression coverage

- Personal feature flags independently enable existing reaction/mutation runtimes and their readback-based uncertain-outcome recovery. Typing remains disabled.
- Accept authenticated Matrix reaction events in encrypted, owner-joined portals, including Beeper's unencrypted reaction envelopes. Text still requires encryption. Normalize presentation variants against the same pinned emoji data as Threema (Beeper sends thumbs-up with an extra variation selector).
- Read stable `ephemeral` and legacy MSC2409 receipt transactions. Persist owner public main-timeline reads before acknowledging the transaction. Ignore private receipts and other readers.
- Resolve visible message and hidden status-event targets separately. Portal schema 9 adds read-target mappings without making status events valid edit/delete targets.
- Native reads use an existing message cutoff, preserve later unread messages and honor native receipt privacy. Native database/controller tests cover cutoff, idempotence, unread counts and privacy; encrypted-store tests cover offline restart, authorization failure, lost response and out-of-order receipts.
- Retry loops back off from five seconds to a one-minute cap during persistent failures, reset after success and remain interruptible. Existing reaction/mutation recovery confirms desired native state rather than blindly repeating uncertain operations.
- Configuration serialization now preserves feature flags, codec paths/encoder and protocol avatar across backup adoption.

Validation passed: 46 focused daily-feature tests and 65 broader bridge-event tests, including backup restoration. Root/headless TypeScript checks, native build and pinned overlay preparation also pass.

Validation commands: `pnpm run test:daily-features`, `pnpm run test:bridge-events`, root and headless TypeScript checks, native bundle build and pinned overlay preparation. The backup restore drill is included in bridge-event coverage.

## Remaining limits

Edits/deletes require native recipient capabilities and time windows. Private Matrix read markers are not forwarded as public receipts. Group read state does not identify individual readers. Old hidden status events without target mappings are ignored rather than guessing a read position. Full long-running outage/canary acceptance and user-directed recovery of genuinely ambiguous sends remain future work. This is a feature expansion, not acceptance of the entire original product specification.
