# Desktop runtime patches

media-cache.json adds an ensureCached(file/thumbnail) method to the eight inbound/outbound media
controllers and their common file-controller type. The method awaits the existing blob loader and
returns void, keeping full attachment buffers out of the model-proxy response. Audio has no thumbnail
loader and rejects that request. Existing download/decryption/retention logic remains upstream-owned.

The preparation script checks original/patched SHA-256 hashes and occurrence counts before applying
changes; it refuses unrelated edits. Source revision and project license are recorded with the Desktop
pin. This patch is a candidate for upstream discussion and has not been submitted.

Validation: headless typecheck/build, focused ESLint and a resolver test exercising the actual cache
method with a synthetic blob loader and a real encrypted local file. This proves the void boundary
and retained-file reread, not a live download. Upstream itself still buffers its download/decryption;
full network-to-cache streaming and fine-grained cancellation remain open work.


## Send ID allocation boundary

`send-ids.json` adds `sendMessageWithIds` to the pinned ConversationViewModelController and its
interface. Existing `sendMessage` still returns void and delegates to it. The new method reuses the
existing text/poll/file preparation, allocates all fragment IDs with upstream randomMessageId,
awaits an optional beforeSend callback with a copy of the complete ID list, then invokes the existing
addMessage.fromLocal for each fragment and returns the IDs. It does not implement protocol send or
message persistence itself. A callback rejection adds no messages; a partial add failure rejects
without automatically retrying. Recording IDs is not evidence that every fragment was sent.

The bridge must supply a durable request-to-ID callback and reconcile unknown/partial results from
the local model before any retry. That durable outbox, worker command, endpoint callback transport
and live send proof are still pending. File preparation may have its own effects before ID
allocation; the new barrier precedes message insertion/protocol scheduling, not media preparation.

The hash-checked manifest is applied by prepare:upstream, including refusal of divergent original
sources. Tests exercise the actual built controller with synthetic crypto, conversation insertion
and prepared media fragments: text/reply preservation, multiple IDs above Number.MAX_SAFE_INTEGER,
callback wait/rejection, mutation isolation, partial insertion and the legacy void interface. They
do not prove actual media preparation, remote delivery, durable callback storage or crash recovery.


## Backend text adapter and Desktop callback transport

The headless session now exposes sendText backed by sendNodeText. It checks the active identity,
canonical chat/reply syntax, nonempty text against the actual compiled Desktop byte limit, and group
membership; resolves the existing conversation/view-model controller; and invokes sendMessageWithIds.
ID conversion uses upstream hex little-endian helpers throughout, including maximum u64 values.
The pre-send hook is now a proxied object with a record method, not a bare callback function.

Desktop's Local<RemoteProxy<T>> inference misidentifies the recorder as PropertiesMarked because
its marker constants are widened to symbol. A narrow documented type correction at the adapter call
preserves the real PROXY_HANDLER object. A built-runtime integration test exercises real Desktop
endpoint serialization, the real patched send controller, the real SQLCipher outbox/worker and a
synthetic conversation insertion. At insertion it verifies that canonical IDs are already committed.
It also checks reply preservation, wrong identity/oversized text rejection, and a persistence error
propagating across the proxy without insertion. No live account or network send was used.

The callback transport inside Desktop is verified. The separate parent/backend-worker allocation
acknowledgement protocol, send command, appservice ingress, echo mapping and live delivery remain
pending. This does not complete Gate 0C or the full outbound path.

## Worker-local model access

`local-handle.json` adds an optional callback to the open/link backend constructors, called
with the local BackendHandle before the existing renderer endpoint is returned. The headless
session uses that local handle: group model views contain contact stores with controllers,
functions and promises and are not structured-cloneable. Normalized records still cross the
outer BackendController worker boundary. Normal desktop callers retain the existing endpoint
behavior. The adapter's RemoteProxy type assertion reflects its await-compatible call surface;
a future cleanup should describe that local adapter interface explicitly.

Validation: native headless typecheck/build, isolated-worker regressions for both open and
link with non-cloneable group member stores, and saved-profile enumeration/topology/directory
reads. The live synchronizer reaches its live state. This does not prove text delivery.
