# Outbound media implementation status

Generic-file sending is wired into service startup and tested offline. Native image/audio/video
sending and file replies remain incomplete. No live account compatibility is claimed.

## Matrix event and download preparation

`resolveOutboundMedia` validates verified encrypted owner events in mapped portals for files,
images, audio and video. It snapshots the encrypted descriptor, validates the MXC reference
and declared size, preserves captions and reply IDs, and rejects unsupported relations and
unsafe filename metadata. Dimensions and thumbnails supplied by the client are not trusted
as canonical prepared media. The classifier performs no I/O or acknowledgement.

`downloadAttachment` uses the pinned SDK request function with a dedicated Undici agent and
no redirect interception. It selects the modern/legacy media endpoint, routes MXC references
through the configured homeserver, supplies bearer authentication and an explicit appservice
user ID, checks status/Content-Length, and streams into verification. HTTP is permitted only
for loopback homeservers. Configured content scanners fail closed until streaming support
exists. A deadline bounds discovery waits and transfer/preparation; the SDK discovery request
itself may finish after cancellation but cannot trigger a later download.

`prepareOutboundAttachment` bounds bytes and chunk sizes, verifies the complete ciphertext
SHA-256 before MIME parsing or plaintext streaming, and keeps only ciphertext on disk. Its
input descriptor must originate in the verified owner event. Disposal closes readers, clears
the retained key and removes the spool. Startup initialization removes abandoned outbound
spools under exclusive profile ownership, preserving referenced inbound spools and unrelated
files. Cleanup does not follow symlink targets.

## Threema storage and worker preparation

The exact-hash `stream-store.json` patch adds `storeStream` to Desktop's file store. Bounded
input is reframed into the existing 1 MiB AES-GCM storage segments, using upstream keys,
nonces and format. Exact byte counts are validated, successful writes synced, and partial
files deleted on observed cancellation or source failure. Cancellation between chunks still
requires a stalled input producer to observe its own signal. Abrupt process death may leave
unreferenced encrypted profile files; full garbage-collection behavior remains unverified.

`NodePreparedFiles` keeps storage handles and keys inside one profile worker. It returns
random 256-bit tokens, binds them to chats, allows a single claim, and reserves aggregate
capacity before asynchronous writes (at most 16 pending entries). Model handoff releases the
registry reference without deleting model-owned data. Claimed data survives uncertain sends.
Tokens are ephemeral: restart recovery must distinguish safe preparation from uncertain send.

The headless session stages files only for its opened identity and an existing sendable
conversation, enforcing membership and the pinned file limit. `BackendController.prepareFile`
and the worker's `prepare-file` command transport bytes over the existing demand-driven
MessagePort channel, with at most 64 KiB per credit. Only the opaque token returns over IPC.
Cancellation closes the source stream, but does not forcibly interrupt a stalled model call.

`discardPreparedFile` now exposes an explicit release command for unclaimed tokens. It
validates profile/chat/token, locks out claims during deletion, and frees capacity only after
successful removal. Already-removed tokens return false, allowing retry after a lost reply.
Claimed tokens cannot be discarded. Shutdown waits for active discards; failed registry
cleanup retains references and can be retried. Focused tests exercise discard/claim races,
capacity restoration, cleanup retries and the IPC payload.

Normal controller shutdown rejects new commands, closes active preparation streams, and
requests session registry cleanup. A two-second deadline bounds that cleanup; errors/timeouts
still terminate the worker. Cleanup waits for active preparation and removes unclaimed files.
Fatal worker failures continue directly to termination. Claimed files are retained because
the send may already have occurred.

## Send boundary and remaining work

The patched controller's worker-local `sendStoredFileWithIds` accepts a prepared generic file
without loading its bytes. Size comes from the storage handle; metadata is checked; upstream
blob keys and the shared ID-recording/message-insertion routine are reused. Storage handles
contain secret wrappers and are deliberately outside the proxy message interface.

The proxy-facing `sendPreparedFileWithIds` now resolves tokens through the backend file
store registry. It derives the destination from its own conversation, rechecks group
membership, claims the token once, then calls the worker-local stored-file method and
releases the registry reference only after successful model insertion. A real Desktop
endpoint test verifies wrong-chat rejection, ID recording before insertion, replay rejection
and model-owned file retention. Handles and keys do not appear in the proxy request.

`sendNodePreparedFile`, the session method, the worker `send-prepared-file` command and
`BackendController.sendPreparedFile` now connect this token path. Both IPC boundaries validate
metadata; the headless adapter verifies profile/conversation/membership. The existing
allocation channel persists canonical little-endian IDs before allowing model insertion.
A compiled integration test exercises the outer controller, acknowledgement MessagePort,
headless adapter, real Desktop proxy and encrypted stored file together. Twelve focused
tests pass alongside both typechecks, the headless build and source-patch verification.

Outbox schema 8 includes an encrypted media request/ID journal. Event metadata is
validated and normalized before persistence; duplicate events keep the original request ID.
Text, reaction, media and rejection classifications are mutually exclusive, and text/media
allocated IDs cannot collide. Media supports PREPARED, DISPATCHING, SENT and OUTCOME_UNKNOWN;
startup converts interrupted dispatch to uncertainty without making it sendable again.
Matching IDs must be durably recorded before SENT. The shared source-order guard recognizes
media predecessors. Seven focused tests pass, including migration, the database doctor and
the encrypted native-Matrix backup/restore drill. Media-specific backup fixtures still need coverage.

`MediaDispatcher` now implements the generic-file state transitions around injected
preparation and authorization. It reauthorizes after preparation, records dispatch before
calling the backend, persists allocated IDs, and makes send exceptions uncertain. Readiness
loss or failed authorization before claim discards the prepared token; failed discards are
retried before re-preparing that chat. Failed chats do not prevent unrelated work. It refuses
native media kinds and file replies until their correct preparation/mapping exists. The
class is tested with the real encrypted journal but is not yet installed in the service.

`createFilePreparation` now connects authenticated Matrix download/decryption to bounded
worker storage and produces the dispatcher's token-backed request. It obtains the effective
limit before downloading, verifies MIME before worker preparation, and removes the download
spool before returning. Failed cleanup after preparation is retained per request for retry;
concurrent preparation of the same request is rejected. Successful dispatch does not discard
model-owned data. A synthetic transport/backend integration test exercises this adapter with
the real encrypted media journal and dispatcher, including the durable ID barrier and a
lowered limit rejecting preparation before download. Five focused tests and typecheck pass.

Generic-file owner echoes now resolve the original Matrix event from allocated media IDs.
The handler checks profile, owner, chat and expected file metadata, binds the existing owner
event before recording observation, and suppresses a second Matrix file event. Observation
settles uncertain media work; late send failures cannot undo it. Schema 8 adds per-part echo
observations, and a schema-7 migration test preserves actual media rows and IDs. Multipart
media, file replies and owner-originated media mutations still require their own handlers.
Seven focused tests pass, including echo checks, schema migration, doctor and backup drill.

Generic-file inbox ingestion now persists a normalized media request before acknowledging the
source event. It waits for older transaction decoding/classification, preserves the original
request ID after an acknowledgement failure, and leaves other consumers' events untouched.
The unsupported-notice worker has an opt-in file admission policy shared with this ingress;
previous durable rejections take precedence. Image/audio/video messages and file replies
remain unsupported. The production runtime installs ingress, dispatch and file-aware notices
together. `test:media-ingress` covers ordering, crash replay,
notice routing, invalid metadata, foreign events and prior rejection preservation.

The media pump uses the same synchronization/crypto readiness gate as text, checks source
ordering around fresh portal authorization, and repeats authorization after preparation.
Startup connects authenticated Matrix downloads, effective local/Matrix/Threema limits,
libmagic checks and worker-local encrypted storage. Runtime shutdown aborts preparation;
limit discovery has a bounded wait and cannot initiate a download after cancellation.
`test:media-runtime` exercises ordering behind text and membership revocation during
preparation. Profile lifecycle tests cover media pump startup/shutdown and abort propagation.

Media queue counts now expose prepared, dispatching, awaiting-echo and uncertain requests
through fixed-name Prometheus gauges and the management status command. Counts read only
state and observation columns, are scoped to the configured profile, and never include
message identifiers or filenames. Restart recovery moves interrupted sends to uncertain;
observed echoes remove them from uncertainty and awaiting-echo counts. `test:media-journal`
and the management/metrics tests cover these transitions and reject invalid metric values.

The journal-sink integration test also injects interruption after the owner-event mapping
commits but before media observation, closes and reopens all three encrypted stores, then
replays the pending echo. A second interruption after observation but before journal
acknowledgement verifies replay of the settled send. The original Matrix event remains the
mapping target, no media renderer/upload or duplicate Matrix event is invoked, uncertainty
clears, and the request never returns to the sendable queue. This proves recovery when the
allocated Threema ID and a matching backend echo are available; missing or mutated echoes
still require further recovery handling.

Reaction targets now consult the durable media request before falling back to an event
mapping. Queued, dispatching and uncertain files leave reactions pending; confirmed sends
provide their allocated IDs. This also prevents a mapping committed just before a crash
from bypassing an unfinished echo observation. The reaction-ingress test covers an earlier
file and later reaction through ingestion, ID allocation, encrypted-store restart, uncertain
recovery and eventual observation, preserving one immutable reaction operation.

Text replies to earlier outgoing files now wait for send confirmation and use the durable
allocated message ID, including when a crash left only the owner mapping committed. The
same rule applies to queued text targets. Missing/future targets retain the explicit fallback
without creating a dependency cycle. Once a reply request is committed, inbox replay preserves
that immutable projection even if the target becomes available before acknowledgement.
`test:reply-target` covers text/file uncertainty and acknowledgement replay. Sending a file
as the reply itself is still incomplete.

Pinned Desktop source inspection confirms `quotedMessageId` is accepted only by the text
send variant; neither its file-send input nor stored-file fragment has that field. File
replies therefore need an explicit fallback or a compound text/file projection, not an
invented protocol field. Separately, the worker controller now validates and snapshots
prepared-file metadata before asynchronous receiver lookup and before claiming the storage
token. Real proxy tests reject malformed filenames/MIME/captions and then successfully send
using the same token. The source patch hashes, rebuilt headless bundle and both TypeScript
checks were verified; ten focused controller/registry tests pass.

## Native codec resource boundary (not yet connected)

Desktop image resizing depends on `createImageBitmap` and `OffscreenCanvas`; the headless
Node process cannot call that implementation directly. `native/media-limits.c` provides a
small exec wrapper for the upcoming codec adapter. It applies hard CPU, address-space,
regular-file output-size, descriptor and core-dump limits before launching an absolute codec
path with a fixed environment. Setup failure prevents execution. Pipe-output bounds,
wall-clock deadlines, cancellation, codec selection and filesystem/network isolation still
belong to the adapter/deployment and are not provided by this helper.

`tests/media-limits.sh` compiles the wrapper and a synthetic probe inside an existing Linux
development image with no network, a read-only root, no capabilities and a temporary build
filesystem. It verifies hard limits, rejected oversized allocation, CPU-limit termination,
environment filtering and malformed limit rejection. These Linux tests pass. The local macOS
runtime refused the requested memory resource limit; it fails closed and is not validated as
a native codec execution platform. Production image packaging and image preparation remain
unfinished.

`runCodecProcess` now provides the Node orchestration for this boundary: trusted executable
and argument arrays, bounded streaming stdin/stdout, discarded and bounded stderr, wall-clock
deadline, cancellation and process-group termination. It waits for child close and both
pipelines before resolving; consumers must keep output provisional until successful completion.
The synthetic-launcher tests cover round-trip streaming, both byte limits, diagnostic overflow,
timeout, nonzero exit, launch failure and cancellation before/during execution. Native hard
resource enforcement remains covered separately by the Linux C tests. Codec-specific image
decoding, canonical metadata, thumbnails and production packaging are still to be connected.

`prepareStaticImage` now forces PNG/JPEG demuxers and pipe-only input protocols, bounds decoded
pixel count, uses one codec/filter thread, strips metadata, and streams a resized PNG. Its
maximum-side setting supports main-image and thumbnail sizes without upscaling. Returned
dimensions come from the generated PNG header and are checked against configured bounds.
Real local FFmpeg tests verify resized dimensions, no upscaling, corrupt/wrong-format input,
pixel/output limits and cancellation. The codec runner also preserves a successful transform's
buffered readable output until its consumer drains it. These tests use a synthetic launcher
on macOS; they do not prove integrated Linux codec isolation. Animation, other image formats,
prepared-image storage/dispatch and production packaging remain unfinished.

Image fixture coverage now includes valid JPEG input, one-pixel-wide/tall images and decoded
alpha values after resizing. This exposed a zero-dimension rounding failure in FFmpeg's
aspect-ratio scaling. The adapter now computes the common scale factor explicitly, rounds
both sides with a one-pixel minimum and emits square pixels. JPEG decoding, thin-image bounds
and transparency checks pass with the real local codec.

`prepareGeneratedAttachment` captures codec output directly into an AES-CTR ciphertext spool
with a byte bound and ciphertext digest. It then reuses the existing digest-verifying outbound
attachment reader for repeatable plaintext streams to worker storage. Only ciphertext is
written to disk; two ciphertext copies temporarily coexist during verification, and the first
is removed before returning. Generated metadata is returned only after both codec and storage
complete. Failure/disposal cleanup and startup cleanup use the existing outbound spool
namespace. The real image test verifies decrypted output equality, ciphertext-only storage,
one retained spool after handoff, and cleanup after a synthetic codec failure. Thumbnail
assembly and worker-native image dispatch remain unfinished.

`prepareImageBundle` now prepares the main image and derives its thumbnail from those canonical
pixels, keeping both in encrypted spools with one disposal operation. Thumbnail dimensions
are capped at the pinned protocol's 512-pixel maximum. Failure in thumbnail generation also
disposes the completed main image, and no bundle is returned until both stages succeed.
Real-codec tests verify main/thumbnail dimensions, two retained ciphertext spools, repeated
disposal and cleanup after a forced thumbnail-output limit failure. Worker-native image
dispatch and production configuration are still not connected.

The worker-local prepared-file registry now supports atomic bundle claim and ownership
transfer. It validates every distinct token and its conversation/state before changing any
entry. Missing, duplicated or foreign thumbnail tokens leave the main image available;
invalid transfer attempts preserve capacity accounting. Real encrypted-storage tests verify
these cases and confirm transferred files survive registry shutdown. The rebuilt headless
bundle and upstream typecheck pass. The image controller/IPC still needs to use these methods.

The prepared-image command now has a strict parser accepting two distinct opaque tokens,
PNG media types, bounded main/thumbnail dimensions, filename and optional caption. It rejects
unknown fields (including storage handles/keys), oversized or nonnumeric dimensions, and
thumbnails larger than the prepared image. Shared filename validation matches the worker's
dot/path/control/bidirectional-control checks. `test:prepared-image-send` verifies canonical
snapshotting and malformed commands; dispatch wiring is still pending.

`createImageStaging` now streams the prepared main image and thumbnail through worker file
preparation, returning a validated command with their opaque tokens and canonical dimensions.
It disposes the bridge ciphertext bundle after staging, cleans known tokens on partial failure,
and retains failed cleanup for retry before preparing the same request again. The staging test
injects thumbnail and cleanup failures and verifies no additional worker files are created
until cleanup succeeds. Native image model insertion, durable canonical-output projection and
service enablement remain pending.

The worker-local stored-media controller now accepts a canonical `stored-image` variant and
creates Desktop's native image fragment with its original encrypted storage handles, thumbnail,
dimensions, caption and regular/static rendering flags. It validates dimensions, PNG types and
distinct handles before allocating IDs. The existing persistence callback still completes
before any model insertion. Real compiled-controller tests cover image projection, invalid
metadata and journal failure without insertion; twelve focused tests, the headless build and
upstream typecheck pass. This internal variant has not yet been exposed through image-token
proxy/worker IPC or enabled in the service.

The Desktop proxy now exposes `sendPreparedImageWithIds`: it validates and snapshots image
metadata, resolves its own conversation, atomically claims the two tokens, performs native
image insertion through the ID-persistence barrier, then transfers both handles to model
ownership. Real endpoint-proxy tests cover duplicate tokens, invalid dimensions, successful
thumbnail-backed insertion and replay rejection. Eleven focused tests, both typechecks and
the rebuilt headless bundle pass. Outer backend-worker IPC, durable canonical metadata and
service image enablement remain incomplete.

Outer image-send IPC now reaches the headless session and Desktop image proxy. Both command
parsing and the headless adapter validate the token/dimension projection; the adapter resolves
the opened profile and actual conversation and rejects left groups. The outer MessagePort
allocation handshake records canonical message IDs before native insertion. The integration
test now sends through the outer controller, allocation port, headless adapter and real Desktop
proxy into encrypted local storage. Twelve focused tests, both typechecks and the 788-module
headless build pass. The media journal still needs a durable canonical image projection before
image ingress/dispatch can be enabled in the service.

Outbox schema 9 adds immutable canonical image projections, separate from the original Matrix
attachment descriptor. The projection contains filename, caption, PNG type, byte counts and
image/thumbnail dimensions; tokens and encryption keys are rejected. A dispatching image must
persist this projection before recording allocated message IDs. Conflicting rewrites fail,
and projections survive uncertain restart recovery. Tests reconstruct schema 8 with pending
media rows, migrate to schema 9, check ordering/immutability/profile isolation, and reopen the
encrypted store. Database doctor, native Matrix backup drill and root typecheck also pass.
Echo matching and image dispatch still need to consume this projection.

Image echoes now match the saved canonical projection instead of the original Matrix file.
Recovery validates filename, caption, PNG types, encoded byte size and prepared dimensions,
then binds the original owner event before recording observation. Tests reopen an uncertain
image send, reject mismatched echoes without settling it, and accept/replay the matching
canonical echo. Thumbnail dimensions/bytes are not exposed by the current normalized message
snapshot, so echo matching cannot compare those fields yet. Three focused echo/journal tests
and root typecheck pass. Image dispatch/service enablement remains pending.

The media dispatcher now accepts an optional image preparation/send route. It checks command
metadata against the canonical projection before claiming, persists that projection after the
claim but before backend invocation, and records IDs through the existing barrier. Mismatched
preparation is discarded while the request stays queued. A lost image-send response retains
the canonical projection and IDs as uncertain work without automatic resend. Cleanup now also
discards prepared resources when a claim succeeded but no backend call was made. Four focused
dispatcher tests and root typecheck pass. Production image preparation/ingress enablement is
still pending.

`createImagePreparation` now assembles authenticated encrypted download, digest/MIME
verification, canonical resizing, thumbnail generation, encrypted spooling and worker staging.
It returns the prepared command with the durable projection, preserves captions and gives
converted PNGs a bounded PNG filename. Its integration test uses synthetic Matrix transport,
real JPEG bytes/encryption and real local FFmpeg, verifies both worker plaintext streams and
their canonical sizes/dimensions, and confirms no bridge spools remain after handoff. Staging
failure tests and root typecheck pass. Production codec packaging and image admission remain
pending; the synthetic launcher does not enforce Linux resource limits in this test.

The shared media runtime can now install image preparation and native dispatch together.
When installed, its ingress and unsupported-notice consumer share PNG/JPEG image admission;
unsupported formats and media replies still receive notices. Profile startup requires the
image backend method when image preparation is configured, and propagates runtime shutdown
cancellation into preparation. Six focused ingress/runtime/notice tests and root typecheck
pass. Service startup has not yet supplied this optional configuration: production codec
packaging and its Linux validation remain to be completed before enablement.

The experimental service image now includes Debian FFmpeg and libmagic (`file`), and compiles
the native `media-limits` launcher in its builder stage. Both architecture builds completed;
the runtime remains UID/GID `1000:1000`. The tested local image identities are:

- `threema-beeper-service:media-arm64`:
  `sha256:eb8109330a07b3f9e2ee270e03de5ef9ece83f89419837b32c679c86139b65bd`.
- `threema-beeper-service:media-amd64`:
  `sha256:ecdd39d2aa31be2f80e2fa5ce32f260084128c1a1247ab70c724381481fe5436`.

On 2026-09-15, both `entry.image-codec.ts` and `entry.image-preparation.ts` passed in each
image with the real Linux launcher and FFmpeg, network disabled, read-only root filesystem,
all capabilities dropped, no-new-privileges, a 64 MiB temporary filesystem and a 768 MiB
container memory cap. Final test files were mounted read-only over the image's test copies.
ARM64 passed with the normal 512 MiB codec address-space limit. AMD64 was emulated on ARM64
and required a **test-only 4 GiB address-space limit**: at 512 MiB the emulator itself aborted
while reserving its VM tracker slab, before FFmpeg started. FFmpeg without the launcher, and
then with only that limit increased, confirmed the cause. Native AMD64 verification at the
normal limit remains outstanding; this is not equivalent evidence.

The valid fixture pixel budget is now 4,096 because AMD64 FFmpeg allocates a padded width
of 64 for a 40-by-20 PNG. The separate 100-pixel rejection remains in place. Tests also verify
thin images, alpha, MIME mismatch, corrupt input, output bounds, encrypted spooling and
cleanup. Root TypeScript validation passes. Temporary stderr instrumentation was removed;
production codec diagnostics remain suppressed.

These are local experimental images, not published releases. Debian package versions still
need reproducible release pinning/provenance. Service image admission remains disabled while
the remaining upstream preparation contract is incomplete.

Review of pinned Desktop `app/ui/modal/media-message/index.ts` and
`common/dom/utils/image.ts` confirms that PNG/JPEG/AVIF are re-encoded from a bitmap,
whereas GIF/WebP retain their original bytes. Main images use a 2,000-pixel maximum side;
JPEG uses quality 0.85, and protocol thumbnails use a 512-pixel maximum side and quality
0.8. Our current PNG-only canonical output does not yet preserve Desktop's JPEG output
format, and GIF/WebP/AVIF are still absent. These remain implementation work, not accepted
scope reductions.

New real-codec fixtures cover EXIF orientation and a two-frame animated PNG. They verify
rotation before resizing, no second rotation on canonical re-decoding, EXIF removal, and
static first-frame PNG output. The EXIF assertion initially failed with local FFmpeg:
`-map_metadata -1` alone did not remove frame side data. Adding `sidedata=mode=delete`
after resizing fixes that leak while preserving orientation. Assertions parse PNG chunk
boundaries rather than searching compressed bytes. The updated codec and preparation tests
pass locally and in ARM64 Linux with the real 512 MiB launcher limit; root typecheck passes.
Linux validation mounted the updated codec/test sources read-only over the previously built
image, so the image identities above do not contain this later metadata-stripping change.

The bounded static codec now supports explicit JPEG output as well as PNG. JPEG uses the
fixed MJPEG encoder, 4:4:4 sampling and quantizer 3; this is not claimed to equal Chromium's
0.85 quality setting. Its dimension validator walks marker boundaries within a maximum
64 KiB header buffer and accepts only the baseline, three-component, eight-bit SOF emitted
by that encoder. The encoded body remains streamed. `prepareImageBundle` can encrypt/spool
JPEG main images and JPEG thumbnails, deriving thumbnail input type from the canonical
main image. Real-codec tests decode both outputs and verify their dimensions and MIME.
Codec/bundle and existing preparation tests pass locally and on ARM64 Linux under the
normal resource limits with updated sources mounted read-only. JPEG worker commands,
durable projections and echo matching still need their PNG-only contracts extended before
the service preparation path selects JPEG output. The default remains PNG during this work.

JPEG propagation is now connected through image preparation, encrypted worker staging,
prepared-image IPC, the pinned Desktop controller patch, durable projections and echo
reconciliation. Preparation preserves PNG/JPEG type and uses the corresponding `.png`/`.jpg`
filename. Main and thumbnail MIME must match; both parsers and the worker/controller enforce
that invariant, and echo matching derives the expected thumbnail type from the immutable
projection. Existing PNG projection rows remain readable without rewriting them.

Nineteen focused tests pass, including real JPEG download/preparation, the actual Desktop
proxy and ID barrier with JPEG metadata, retained PNG insertion coverage, and encrypted
restart/echo reconciliation for both types. Incorrect main or thumbnail MIME cannot settle
an uncertain send. Both typechecks and the 788-module headless build pass; source preparation
verifies updated patch hashes and overlay content. Service startup still does not enable
image admission. GIF/WebP/AVIF and full upstream media preparation parity remain outstanding;
the local container images have not yet been rebuilt with these changes.

`prepareGifBundle` now preserves GIF bytes in the encrypted spool and creates a first-frame
JPEG thumbnail through the resource-limited codec. It reads only the ten-byte signature and
logical canvas dimensions while streaming the original into storage, enforcing byte and
pixel limits. Neither part is returned until thumbnail decoding completes. The retained main
image is not resized or metadata-stripped, matching Desktop's GIF preservation policy.
Tests use a real two-frame GIF, compare the decrypted main image byte-for-byte with its
source, verify thumbnail MIME/dimensions, and require cleanup after truncated input, excessive
pixels, thumbnail output failure and cancellation. Codec/preparation tests and typecheck pass
locally; the codec suite also passes on ARM64 Linux with the normal resource limits and current
sources mounted read-only. GIF admission, distinct main/thumbnail MIME in durable projections,
worker send contracts and full animation/large-file coverage remain to be implemented.

A 90-frame GIF larger than 256 KiB exposed an early-stdin-close bug: the thumbnail decoder
finished its first frame before the original animation had been written into its pipe, and
the resulting EPIPE was treated as a codec failure. GIF decoding now explicitly permits that
early close while draining the remainder through the existing bounded input pipeline. Success
still requires a zero child exit status and successful completion of the entire source; late
source failures, byte-limit violations, timeout and cancellation remain fatal. Other codecs
retain strict input-close behavior. Tests isolate a child that reads a prefix and exits,
verify multi-chunk source exhaustion, reject late source failures and nonzero exits, and run
the large animated GIF fixture. The updated process/image suites pass locally; the JPEG preparation regression also passes.
ARM64 Linux process tests pass, but its large-GIF test still fails with `pipe:0: Input/output
error`. Inspection of the packaged version's [FFmpeg 5.1.9 GIF demuxer source](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n5.1.9/libavformat/gifdec.c)
explains a second incompatibility: header parsing scans the animation and seeks back to offset
zero, and packet reading also seeks backward. Large input cannot be rewound through a pipe.
The newer local decoder passes. Packaging a suitable streaming decoder or providing bounded,
secure seekable input remains necessary; the failing Linux regression is retained. Temporary
synthetic stderr instrumentation was removed. No live account operations were performed.

Linux codec packaging is being updated to FFmpeg 8.0.3 from its official source archive.
`docs/FFMPEG-PINS.json` records the archive hash and release-signing fingerprint. The detached
signature was verified against the fingerprint published on FFmpeg's download page.
`pnpm run prepare:codec` downloads the archive into ignored local storage, verifies its pinned
SHA-256, and atomically publishes it without replacing an existing file. Linux staging verifies
the archive again and includes it in the context-integrity manifest. The codec builder compiles
FFmpeg/ffprobe with explicit encoder/decoder selections, zlib, network support disabled and
external-library autodetection disabled. The runtime receives binaries, LGPL license text,
source pin and build configuration. AVIF encoding/decoding and video encoding are not yet
included in this configuration; these remain required work. Debian toolchain/zlib package
versions and full release reproducibility still need pinning and verification.

Both architecture builds were started from context
`5bf09e377ebcf6024a80fe7f50350d01c8b0f0f00e494555c89a5f4853d669b1`.
Build logs are ignored local artifacts `.local/linux-codec8-{arm64,amd64}-build.log`.
The source pin and context verification pass. The ARM64 service image built successfully as
`sha256:bec7581fc86a8d134b36b1679a6d7f6f815eabc3e118e978dba3acb8bd9934cc`
(`threema-beeper-service:codec8-arm64`). All three process/image/preparation suites pass using
the tests embedded in this image, including the previously failing large GIF, with networking
disabled, read-only root, dropped capabilities, no-new-privileges, 768 MiB container memory
and the normal 512 MiB codec address-space limit. The same image also passes all 13 existing
offline native persistence, Matrix device/session, backend lifecycle and service resource/startup
probes with network disabled and no host mounts.

The AMD64 image also completed:
`sha256:cf7e1b0ba1401eb229a453150d1e9aa199eacc4ea47ffc5eebe3d703007a5eef`
(`threema-beeper-service:codec8-amd64`). Its embedded process/image/preparation suites all
pass under emulation with the same isolation, a 768 MiB container memory cap and the previously
documented test-only 4 GiB codec address-space allowance. Native AMD64 verification using the
normal limit is still required. Neither image yet includes the subsequent GIF send-path changes.

GIF preparation is now connected to image staging, IPC, the real Desktop controller, immutable
projections, echo matching and optional image ingress. Its original bytes and dimensions are
retained and its thumbnail is JPEG. Canonical thumbnail type is a fixed policy derived from
the persisted main type: PNG for PNG, JPEG for JPEG/GIF. This preserves the interpretation of
existing PNG/JPEG rows while rejecting inconsistent worker commands and echoes. Service startup
still does not supply the image configuration; WebP/AVIF remain unsupported.

Twenty-four focused cases pass across preparation/staging, media ingress, dispatcher, encrypted
journal restart, the actual Desktop proxy, IPC validation and allocation barriers. Restart/echo
tests cover all three MIME types; real encrypted download tests compare retained GIF bytes
exactly and verify a JPEG thumbnail. The actual proxy exercises both JPEG and GIF while retaining
PNG insertion coverage. Test setup reuses Desktop's process-wide endpoint service while each
case owns separate storage and endpoint pairs. Both typechecks, patch/overlay verification and
the 788-module headless build pass. Live animation rendering and complete service enablement
remain unverified.

The shared preserved-byte implementation is now `prepareRetainedImageBundle` in
`src/media/retained-image-bundle.ts` (replacing `gif-bundle.ts`). It supports GIF and static
WebP originals with JPEG thumbnails. WebP dimension inspection walks a maximum 64 KiB RIFF
prefix, validates the declared total size and reads VP8X, VP8L or VP8 canvas dimensions;
actual image decoding is still performed by the limited codec. Original WebP bytes remain
unchanged in the encrypted spool. Real synthetic fixtures cover lossless and lossy/alpha
WebP, thumbnail dimensions and exact retained bytes, plus incorrect RIFF lengths/truncation
and cleanup. Existing GIF/JPEG preparation and staging tests and root typecheck pass. The
updated codec suite passes on ARM64 Linux with source files mounted read-only.

Inspection of the pinned FFmpeg 8.0.3 `libavcodec/webp.c` shows that ANMF animation chunks
are skipped as unsupported. Static decoding therefore does not establish animated WebP
support. A bounded animation-capable decoder path, end-to-end WebP metadata propagation and
admission remain required; WebP is still rejected at ingress. The newly built codec images
do not yet include this shared-bundle refactor.

`native/webp-first-frame.c` now provides an animation-capable first-frame path using
libwebp's own compositor. It buffers only the bounded container prefix through the first
complete VP8/VP8L/ANMF chunk (maximum 32 MiB), validates RIFF/chunk bounds, and supplies a
single-frame container to libwebp. Canvas bounds are checked before allocating decoded
pixels. It emits RGBA PAM to stdout, with no source metadata or plaintext files. The outer
codec runner drains later bytes under its existing limits even when this helper exits early.

The local test uses libwebp 1.6.0 and a synthetic two-frame animation with an offset first
frame, quarter alpha and a larger transparent canvas. It checks every RGBA pixel, confirms
that the second frame is absent, compares output with a 2 MiB trailing chunk and EXIF data,
and rejects truncated input, oversized chunk declarations, prefix and canvas limits. The
helper is not yet packaged for Linux or connected to WebP thumbnail preparation; those steps
and PAM-to-JPEG conversion remain required before WebP admission can be enabled.
The test passes with AddressSanitizer/UndefinedBehaviorSanitizer enabled for the helper;
separate direct checks of all five negative cases confirm clean failure without sanitizer
diagnostics. The system libwebp itself is not sanitizer-instrumented. Root typecheck passes.

`prepareWebpThumbnail` now streams the helper's RGBA PAM output directly into limited FFmpeg
JPEG encoding. Intermediate pixels do not touch disk. Both processes have bounded streams,
timeouts and cancellation; a failure aborts the other process and no thumbnail is accepted
until both complete successfully. Retained WebP preparation now uses this path for static and
animated input. Five local codec/helper/preparation/staging cases pass, including the offset
animation, unchanged original bytes, JPEG dimensions and forced output-failure cleanup.

Linux packaging now builds libwebp 1.6.0 from the official archive pinned in `WEBP-PINS.json`,
statically links the helper, and includes libwebp copyright/patent/authorship notices, source
pin and build configuration. `prepare:codec` verifies both codec archives, and staging includes
them in the integrity manifest. Unlike the FFmpeg pin, the libwebp detached signature has not
yet been verified; its recorded hash is from the official HTTPS download. FFmpeg's explicit
decoder list now includes PAM. Both architecture builds were started from context
`6a54c7db5153a697ff47ebce436b1130161fb5c8bceb34c80cfc03802919ba2b`, with logs under
`.local/linux-webp-{arm64,amd64}-build.log`. Linux execution and WebP send admission remain
pending; these changes do not establish end-to-end WebP sending.

Initial Linux builds found two packaging omissions: the dedicated C builder needed
`libc6-dev`, and libwebp's `sharpyuv` prerequisite must be built before its `src` tree.
Both are corrected. Replacement builds use context
`296561cefd1d7105bf002de81f8085bdb4d297a62bc4d197ec848fcd88ce8d55` (v18);
the superseded v17 builds failed and are not validation evidence.

The corrected ARM64 image built as
`sha256:c63e9b4b015fbbd9284aecaf75b434728c0f006d1d8d96b44c17184e7b1c2c06`
(`threema-beeper-service:webp-arm64`). Its five embedded process/image/preparation/helper
cases pass without host mounts, with networking disabled, read-only root, dropped capabilities,
no-new-privileges, a 768 MiB container memory cap and normal 512 MiB per-codec address-space
limits. This validates the actual source-built Linux compositor and PAM-to-JPEG pipeline.
The AMD64 build is still in progress; neither build includes the following later send changes.

WebP is now connected to retained preparation, worker staging/IPC, the Desktop controller,
immutable projections, echo reconciliation and optional image ingress. Original animation bytes
and canvas dimensions are retained, with a JPEG thumbnail. Existing PNG/JPEG/GIF projection
interpretation is unchanged. Filename truncation now accounts for the five-byte `.webp` suffix.
Tests cover encrypted animated-WebP download and exact original-byte retention, the actual
Desktop proxy's allocated-ID barrier, and restart/echo matching for all four formats. Unsupported
AVIF remains with the notice consumer. Image admission is still not enabled by service startup.
All 27 focused send-path cases pass, together with both typechecks, patch/overlay verification
and the 788-module headless build. These tests do not prove live animation rendering in Beeper.


The corrected AMD64 WebP image also completed as
`sha256:556f853326831a59adb3e8e81a271226b21868da5e0a0931b998beb0628a7478`
(`threema-beeper-service:webp-amd64`). All five embedded codec cases pass under Docker
AMD64 emulation, with networking disabled, a read-only root and a 768 MiB container cap.
Emulation requires the test-only 4 GiB address-space allowance; native AMD64 validation
with the normal 512 MiB limit remains pending. Like the ARM64 v18 image, this predates
WebP send-metadata integration.

`native/avif-first-frame.c` adds a local libavif decoder probe that reads stdin through a
bounded, lazy prefix cache (at most 32 MiB), with declared input size at most 1 GiB and
pre-decode canvas/pixel limits. It emits first-frame RGBA PAM and applies clean-aperture
cropping, rotation and mirroring. It ignores source EXIF/XMP and writes no plaintext files.
Its custom IO follows the [libavif 1.4.2 interface](https://raw.githubusercontent.com/AOMediaCodec/libavif/v1.4.2/include/avif/avif.h).
The committed synthetic lossless fixture verifies exact RGB/alpha pixels across all eight
rotation/mirror combinations on a non-square crop, plus corruption, truncation, prefix,
pixel and declared-size rejection. Run `test:avif-first-frame` after compiling the helper
with `cc -O2 -Wall -Wextra -Werror native/avif-first-frame.c -o .local/avif-first-frame $(pkg-config --cflags --libs libavif)`.
Both cases also pass with AddressSanitizer/UndefinedBehaviorSanitizer on the helper;
the linked system libavif is not instrumented. Root typecheck passes.
This remains a probe: color management/HDR, animation and grid fixtures, source-pinned
Linux packaging, bounded process integration and pinned Desktop output-format parity
remain required before AVIF admission. No production path invokes it yet.


`prepareAvifImage` now connects the helper to bounded FFmpeg encoding through the shared
`prepareDecodedImage` pipe. WebP thumbnail preparation uses the same process coordination.
Both subprocesses must finish successfully; either failure aborts the other, and cancellation
waits for cleanup. AVIF's declared byte count is checked against the fully drained source,
even when its first-frame decoder closes stdin early. Pixel intermediates remain in pipes.
The adapter can produce PNG/JPEG for parity experiments; this does not decide the final
Desktop-compatible AVIF output policy or enable AVIF ingress.

`test:avif-image` verifies canonical dimensions, encrypted output storage, complete draining
of a 2 MiB tail, late source errors, declared-size mismatch, output exhaustion, a missing
decoder and cancellation of a stalled input. Each failure leaves no attachment spool.
The AVIF helper/pipeline and existing image-codec tests pass (four cases), and root typecheck
passes. These local macOS adapter tests use a synthetic limiter; actual AVIF Linux hard-limit
execution remains dependent on source-pinned libavif/AV1 packaging.

The [AVIF parity investigation](AVIF-PARITY.md) now establishes from pinned source that
AVIF main output is PNG but its original-source thumbnail is JPEG. `prepareAvifImage` now
fixes PNG output accordingly. The native decoder also passes an exact-pixel two-frame
animation regression. Explicit thumbnail MIME persistence and original-source thumbnail
preparation are required before AVIF ingress, alongside color management and packaging.

AVIF now has an independent-original-source PNG/JPEG bundle with encrypted outputs and
shared failure cleanup (`prepareAvifBundle`). Its regression verifies original-source thumbnail
dimensions even when the main is reduced further, plus cleanup after thumbnail exhaustion and
source disposal failure. Mixed thumbnail MIME persistence/staging and color/encoder parity
remain pending; see [the detailed contract](AVIF-PARITY.md).

Outbox schema 10 now persists explicit `thumbnailMediaType` in canonical image projections.
The parser normalizes schema-9 rows using their original fixed MIME mapping; no uncertain
send is re-prepared. Projection thumbnail dimensions have independent 512-pixel bounds,
matching original-source preparation. Echo reconciliation compares stored thumbnail MIME,
and dispatch rejects command/projection MIME disagreement before claiming work. The doctor
now recognizes schema 10. Restart tests cover four legacy MIME combinations and PNG/JPEG,
including wrong-thumbnail echo rejection. The native encrypted backup/restore drill and
read-only doctor pass with schema 10. Worker staging and the Desktop proxy still enforce the
older MIME-pair policy and must be updated before connecting AVIF bundles.

Prepared-image IPC, staging and both Desktop controller paths now accept independent PNG/JPEG
thumbnail MIME and thumbnail dimensions up to 512. Seventeen send/staging/ID-barrier cases
pass, including mixed PNG/JPEG through the real Desktop proxy with a thumbnail larger than
its reduced main image. Both typechecks, pinned patch/overlay verification and the headless
build pass. This removes the schema-10 follow-up's worker MIME-pair restriction. AVIF ingress
remains disabled pending codec packaging and rendering parity.

JPEG output now composites transparency on black before resizing, fixing transparent pixels
becoming bright colors and hidden-color bleed at edges. Pixel tests cover four alpha levels,
unchanged PNG RGBA and equivalence to an explicitly flattened edge fixture. Five local codec/
preparation cases and the source-built Linux ARM64 codec test pass with hard limits. The Linux
test uses read-only source mounts; a new release image containing this change is still needed.
See [AVIF parity](AVIF-PARITY.md) for the remaining resampling/color/quality distinctions.

Linux ARM64 AVIF packaging now builds libavif 1.4.2 and dav1d 1.5.4 from hash-pinned official
archives, with static decoder linkage and license/build metadata in the runtime. The v20 image
passes eight embedded codec/preparation cases without host mounts, including AVIF crop, alpha,
first-frame animation, encrypted output and cancellation. Its pipelines use actual hard limits.
Matching AMD64 compilation is in progress. See [AVIF parity](AVIF-PARITY.md) for image/context
hashes and remaining signature, rendering and admission work.

The matching AMD64 AVIF image now passes eight embedded cases under emulation (4 GiB test-only
address-space limit, 768 MiB container cap). AVIF is also connected to `createImagePreparation`:
verified encrypted download, independent PNG/JPEG bundle, original filename, immutable output
metadata and opaque worker staging. Four-format preparation tests pass locally and on Linux
ARM64 with hard limits, including corrupted-AVIF rejection before staging. Linux integration
validation uses read-only source mounts because the v20 images predate this change. AVIF
remains outside ingress and production image admission pending rendering/color parity.

An executed Electron 40.10.0 renderer probe now supplies committed AVIF reference pixels.
It exposed a clean-aperture difference: Desktop ignores the crop, so the native helper now
retains the full canvas before rotation/mirroring. Local integration and sanitizer regressions
pass; reference dimensions/alpha match, with at most two RGB levels of difference on the
translucent grid and exact animation pixels. V20 Linux images predate this correction.
See [the renderer comparison](AVIF-PARITY.md) for remaining resizing/color/HDR differences.

The native AVIF helper now converts embedded RGB ICC profiles to sRGB with pinned Little CMS
2.19, preserves alpha and rejects malformed/oversized profiles before emitting pixels. A
synthetic P3/gamma fixture reduced its maximum renderer-reference error from 60 to five RGB
levels; that residual remains unproven parity. Local sanitizer/bundle tests pass. Both Linux
architectures are building v21 with the crop correction, AVIF integration and static ICC
converter. See [the ICC comparison](AVIF-PARITY.md) for remaining CICP/HDR/precision work.

CICP-only AVIF color now uses declared primaries and supported SDR transfer curves for sRGB
conversion. Executed P3/linear renderer fixtures reduce errors from 60/76 to at most four RGB
levels; BT.709 has a renderer-observed sRGB interpretation. Unsupported HDR transfers fail
explicitly while HDR implementation remains pending. Local reference/integration/sanitizer
checks pass. AMD64 v21 passed eleven embedded ICC cases under emulation, but both v21 images
predate CICP integration. See [the CICP comparison](AVIF-PARITY.md) for precise limits.

Executed 10-/12-bit linear AVIF fixtures exactly match Desktop's current eight-bit
quantization, so precision was preserved at the verified behavior rather than changed on
assumption. The v22 ARM64 image passes twelve embedded cases including the nine renderer
references and current CICP conversion. Matching AMD64 compilation continues. These checks
do not establish HDR, resampling or complete color parity; image admission remains disabled.

Native AVIF now accepts PQ/HLG and applies Chromium-derived SDR tone mapping in bounded
scanline buffers. Executed opaque PQ fixtures (including CLLI metadata) match exactly;
HLG differs by at most one RGB level. Local integration, sanitizer and type checks pass.
HDR alpha/gain maps, broader rendering parity and Linux rebuilds remain. AMD64 v22 passed
all twelve embedded pre-HDR cases under emulation. See [HDR status](AVIF-PARITY.md).

HDR alpha now has executed PQ/HLG renderer fixtures. Fully transparent HDR output clears
hidden RGB like Desktop; alpha is exact and partially transparent RGB stays within measured
fixture tolerances. Eleven local cases and six sanitizer cases pass. ARM64 v23 passes twelve
embedded cases including all fourteen renderer references without host mounts and with real
codec limits. AMD64 compilation continues; gain maps, resampling/JPEG quality and remaining
color differences still block production image admission.

JPEG preparation now uses the source-built libjpeg-turbo helper after a bounded FFmpeg PAM
pipe, with main quality 85 and thumbnail quality 80. Explicit alpha rounding matches all
nine committed pinned-renderer fixtures through the full pipeline without resizing. PNG/JPEG
thumbnails independently read the verified original, and all image filenames are preserved.
ARM64 v26 passes the fifteen embedded media cases, including source-cleanup failure and a
thumbnail larger than the downsized main. See [JPEG parity](JPEG-PARITY.md) for exact image
identities and remaining AMD64 validation. These results supersede earlier descriptions of
the MJPEG q-scale encoder and thumbnails derived from canonical main images. Production
image admission remains disabled while sampling, non-AVIF color conversion and broader
metadata behavior are incomplete.

Remaining: complete native image/audio/video preparation, resource-limited codecs and canonical
metadata, reply mapping, complete restart/uncertain-send reconciliation and live Beeper
compatibility. Unsupported native media and file replies retain notices.

## Validation

Focused tests cover event metadata, streamed download/decryption, spool cleanup, real Desktop
storage compatibility, registry lifecycle, byte-stream IPC, the ID-recording barrier, and
shutdown success/failure/timeout. Relevant commands are `test:outbound-media-event`,
`test:download-attachment`, `test:outbound-attachment`, `test:outbound-spool-cleanup`,
`test:prepared-files`, `test:prepare-file-command`, `test:backend-shutdown`, plus existing
file-stream, byte-stream, backend-controller and send-ID tests. The headless bundle and
TypeScript checks pass. These checks do not establish live account compatibility.
