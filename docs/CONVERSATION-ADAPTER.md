# Conversation enumeration

`BackendController.conversations()` returns a validated plain-data list from the linked backend.
The Desktop overlay reads `model.conversations.getAll()`, each conversation's receiver, and its
last-message store. It returns the canonical chat ID, display name, unread count, archived/pinned
flags and optional last-message ID. It includes archived conversations; it does not filter by UI
visibility. Neither remote stores nor backend controllers cross the worker boundary.

Direct IDs use `c:<identity>`. Group IDs use `g:<creator identity>:<group ID hex LE>`; a creator of
`me` resolves to the backend's own user identity. Message IDs use `m:<message ID hex LE>`. The
adapter calls upstream `u64ToHexLe` directly and never converts a numeric ID to a JavaScript number.
The boundary rejects malformed IDs, duplicate chat IDs, unsafe counts and invalid state flags.

This is a point-in-time enumeration, not an atomic multi-model snapshot or a change subscription.
Live subscriptions must attach before snapshot reconciliation to avoid losing concurrent updates.
Distribution-list receivers currently reject the enumeration with a typed worker operation error;
they must not be mistaken for a direct chat or group. Separate contact/group records, message
enumeration, model subscriptions, pagination and Matrix portal reconciliation remain pending.

`pnpm run test:conversations` tests the bundled upstream adapter with synthetic model stores,
including golden high-bit little-endian IDs and creator resolution. Worker tests reject enumeration
before a profile has opened. No test has enumerated the owner's real conversations yet.

`node-watch.ts` now provides the inner-model subscription primitive for reconciliation. It installs
the outer delta listener before enumerating, subscribes to each current and newly added model,
emits full model values on every change, and detaches removed models. `CLEARED` stops all listeners
and invokes reset; a callback/normalization failure also stops the watcher and invokes failed.
Both conditions require the caller to begin a new reconciliation. Stop is idempotent. Callback
values are worker-local models and must be normalized before IPC; they must never be serialized raw.

`pnpm run test:model-watch` uses the actual bundled upstream writable/set stores to verify edits,
reactions, additions, removals, clear/reset, failure cleanup, and changes triggered synchronously
during the initial snapshot. Wiring these watchers into contact/group/message normalization and
the durable snapshot-plus-live event stream remains pending.
