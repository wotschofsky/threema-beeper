# Upstream patch ledger

Base: Threema Desktop `v2.0-beta65`, `63f65806398400017201ef2aaa4f97dfc122e5b0`.

No existing upstream runtime source has been modified. The original handoff is preserved as
supplied. These additions are spike-only:

| Files                                                       | Reason                                                                       | Validation                              | Upstreamability                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| `apps/desktop/config/vite.headless-spike.config.ts`         | Reuse upstream build definitions with a Node 24 entry and TS path resolution | Builds a 584-module backend bundle      | Replace with a proper headless target after linking passes |
| `apps/desktop/src/headless/entry.probe.ts`, `tsconfig.json` | Load backend, initialize WASM, check empty-profile identity presence         | Node 24 execution, strict types, ESLint | Diagnostic only; not a lifecycle adapter                   |

Builder corrections live in `deploy/docker/`: pin Binaryen 123, install protoc for the Rust
dependency, and compile native addons explicitly with Node 24. The native driver regenerates Argon2
declarations from upstream JSDoc inside ignored dependency output. No cryptographic or protocol
implementation is changed.

Matrix's default encryption path depends on Pantalaimon. ADR 0001 records the finding; no Matrix
source patch has been applied.

Each future source patch must record its files, reason, compatibility impact, tests, and suitability
for upstream contribution. Do not combine an upstream upgrade with bridge feature changes.

Subsequent native integration now adds SDK overlays under `integrations/matrix/overlay` and a
fingerprint-checked framework patch under `integrations/matrix/framework-patches`. These are explicitly
modified upstream TypeScript, with original MIT/Apache notices preserved. They are applied only to
the ignored pinned checkouts/dependencies and must be included with corresponding release source.
See each patch directory's README for exact behavior and tests.

Matrix SDK recipient lookup failure patch: `matrix-overlay/e2ee/RustEngine.ts` changes
`prepareEncrypt` to reject failed membership queries and empty eligible membership, rather than
continuing with partial recipients or a prior session. Compatibility impact: transient membership
outages now fail sends and enter the bridge retry path. Suitable as an upstream correctness fix;
no changes to cryptographic algorithms. Validation uses the native two-device exchange with failed
membership queries, removal/session rotation and rejoin/history exclusion. Original package version
and file hash are pinned by the overlay manifest. This patch has not been submitted upstream.

Matrix SDK stream body patch: `matrix-overlay/http.ts` accepts Node Readable bodies alongside Buffer,
keeps the requested content type and logs only a stream marker. This avoids JSON-serializing streams
and supports bounded encrypted attachment upload. Original fingerprint is in source.json. Validation
intercepts the SDK's actual undici request boundary and verifies streaming ciphertext. Candidate
upstream enhancement; not submitted.

Desktop media-cache runtime patch: five source files (four media controllers plus common controller
types), recorded in desktop-patches/media-cache.json. Eight controllers expose a void ensureCached
method so the bridge can request upstream retention without copying full blob responses across the
model proxy. Source hashes/occurrence counts are checked before application. This is now an explicit
modification of original Desktop runtime code, superseding the initial spike-only statement above.
Headless build/typecheck, focused lint and a synthetic loader/real local-store test pass. Upstream
buffering/cancellation are unchanged; no submission has been made.


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

## Bounded history selection (2026-09-15)

`src/headless/node-history-window.ts` and the reader change in `node-history.ts` retain only one page plus a lookahead candidate while traversing the existing upstream message set. No protocol or database API is replaced. The overlay preparation manifest includes the new module; rebuilding the native bundle and running `pnpm run test:history` verifies cursor ordering and the 100,000-model fixture. The upstream full-model allocation and repeated scans remain; see `RECONCILIATION-PERFORMANCE.md` for the precise performance scope.

## Typed headless connection dialogs (2026-09-16)

The local `node-platform` overlay now dismisses the five whitelisted compatibility
and device-state dialogs, reporting only their typed categories through the Node
session callback. It never confirms an action or forwards arbitrary context.
This fixes the unsupported frontend-service exception on known connection errors;
protocol negotiation and upstream disable/reconnect decisions remain upstream.
The helper is `node-connection-issue.ts`; preparation copies it alongside the
platform/session overlays. The rebuilt bundle and eight offline boundary/lifecycle
tests pass. This is headless-adapter behavior rather than a protocol patch; no
upstream pull request has been submitted. See `CONNECTION-ISSUES.md` for exact
scope and persistence/notification integration status.
