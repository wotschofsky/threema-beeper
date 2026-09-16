# Profile message synchronization

`ProfileSynchronizer` owns message reconciliation for one already opened, exclusively locked
profile. Before it starts, the caller supplies the BackendController and MessageJournal. Startup
discards incomplete staging from previous attempts; do not run two coordinators for the same profile.

Each pass attaches the profile topology listener before enumerating chats, then attaches every
chat's message listener before making any history request. It reads history sequentially in bounded
pages while live updates are durably staged. It commits snapshot/live staging and switches all
callbacks to ordinary journal upserts without an asynchronous gap. `readyForMessages` becomes true
only after every chat completes. Delivery and outbound consumers must additionally check this flag;
the coordinator does not itself send messages.

Topology or message-stream invalidation clears readiness immediately, stops every subscription,
discards remaining staging and retries with capped exponential backoff. History/storage errors
take the same recovery path. A periodic full pass (one hour by default) repairs missed changes.
Stop interrupts retry/periodic waits and waits for active source requests and cleanup. A cleanup
failure stops the coordinator instead of starting overlapping subscriptions. External backend
reconnect/reopen remains the service owner's responsibility.

States are `stopped`, `syncing`, `live` and `retrying`. These describe message-model readiness, not
Matrix connectivity or successful delivery. The coordinator reads canonical contact/group metadata
under topology observation, then publishes that metadata and every staged chat in one SQLCipher
transaction. The delivery consumer must honor the readiness gate across the whole pass. A durable
completed epoch identifies the metadata snapshot; detailed SyncBegin/SyncEnd event records and
Matrix metadata application remain pending.

`pnpm run test:profile-sync` verifies all-watcher-before-history ordering, stale snapshot/live replay,
readiness changes, automatic topology retry, cleanup, failed history and interruption of backoff.
Tests use synthetic source events and a real encrypted journal. Live accounts, large profiles,
production supervision and delivery integration remain unverified.
