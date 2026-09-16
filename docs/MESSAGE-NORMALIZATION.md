# Message normalization

The Desktop overlay's `node-message.ts` converts an upstream remote message model into an explicit
`NormalizedNodeMessage` record. Inbound sender identity comes from the sender model; outbound sender
identity is the logged-in user. IDs use upstream little-endian serialization. The upstream safe
integer ordinal becomes a bigint without passing a 64-bit message ID through number.

The record preserves creation, receipt, send, delivery, read, edit and deletion timestamps, the full
reaction set and text replies. Content distinguishes text, image, video, audio, file, deleted, poll
and unsupported. Media metadata includes MIME, filename, byte size, caption, dimensions and duration
where available, plus blob/thumbnail references. Duration is in seconds. Polls preserve creator,
ID, description, settings, choices and votes. Deleted content contains no original body; unknown
types produce a fixed safe unsupported description.

Only explicitly selected fields are returned. Raw protocol bytes, encryption keys, local encrypted
file records and controllers are excluded. This does not download any blobs. A blob reference is
absent until upstream exposes a blob ID; locally pending attachments still need a stable reference
resolver. Content hashes are not exposed by these upstream views and remain a media-layer task.

`pnpm run test:message-normalization` runs synthetic models through the actual bundled normalizer.
It checks high-bit IDs, replies, sender identity, reaction/edit preservation, all media kinds,
deleted/unknown content, polls and key/body exclusion. Upstream and root typechecks and focused lint
pass. No owner messages were read. Enumeration, worker-boundary validation, durable serialization
of bigint/dates, and wiring normalization into subscriptions remain pending.

The headless session now provides `history(chatId, limit, after?)` through `node-history.ts`.
It resolves the canonical chat ID, reads retained messages from the upstream conversation model,
orders by ordinal then canonical message ID, and normalizes at most 500 messages per page. The
cursor contains decimal ordinal and fixed-width message ID; it remains usable if the last returned
message is removed. Missing conversations fail explicitly; empty conversations return an empty page.

These are bounded output pages, not bounded database reads: upstream `getAllMessages()` still
materializes the collection and this first implementation sorts its model references on each call.
The 100,000-message performance acceptance test and a repository-level pagination optimization are
pending. The pages are not a frozen snapshot: live watchers must already be attached to capture
edits and insertions behind the cursor. IPC exposure and durable reconciliation are still pending.
`pnpm run test:history` verifies ordering, cursor deletion, invalid requests and missing/empty chats
with synthetic stores through the compiled upstream adapter.

`BackendController.history(chatId, limit = 100, after?)` now exposes this operation through worker
IPC. Both sides validate the request; the worker validates its normalized output before posting,
and the controller validates and detaches the response. Validation covers every content variant,
dates, bigint ordinals, identity/ID formats, exact field allowlists, ordering, duplicate IDs,
requested chat and continuation matching. Pages are capped at 500 records, 100,000 value nodes,
12 nesting levels and 16 MiB of string content, with per-field/array limits as well. Oversized pages
fail; callers must retry with a smaller page size. These bounds do not eliminate upstream's
full-collection memory cost.

The shared message type is isolated in the dependency-free `node-message-types.ts` overlay so the
worker and bridge use the same record definition. IPC preserves Date and bigint; durable encoding
still needs an explicit codec. History validation tests include cyclic and malformed input,
extra secret fields, wrong-chat records, duplicate/stale cursors and all normalizer content variants.
Live linked-profile history and synchronization remain unverified.
