# Outbound video implementation

Status: prepared-command contract, worker-local controller and worker IPC route implemented;
durable dispatch, echo recovery, isolated metadata inspection and initial MP4 conversion implemented.
Original-file fallback, optional thumbnail preparation and main/thumbnail token staging are
implemented, including opt-in profile-runtime download/dispatch wiring. Thumbnail pixel parity
and production admission remain incomplete.

The handoff requires outbound video preparation with duration, dimensions, caption and
thumbnail metadata, enforced limits/cancellation and durable send IDs. The pinned Desktop
`common/utils/video.ts` targets MP4 with AVC video and AAC audio through Mediabunny. It
normalizes the conversion start to `input.getFirstTimestamp()`, rejects conversion when
tracks are discarded, and records `input.computeDuration()`. The quality preference is
explicitly ignored in this pinned helper (DESK-1998); inventing quality presets would not
match its behavior. The conversation controller falls back to an original generic file if
conversion fails. Thumbnail generation samples the primary video track using a range
iterator; thumbnail storage is optional in the resulting message fragment.

`src/threema/prepared-video-send.ts` defines the initial IPC contract: an opaque primary
token, `video/mp4`, positive finite duration up to 10000 seconds, dimensions bounded to
8192 per axis, filename and optional caption. An optional thumbnail must supply all four
fields together: distinct opaque token, PNG/JPEG MIME and dimensions up to 512 per axis.
Storage handles, encryption keys, audio-duration fields and unknown fields are rejected.
These bounds follow the existing prepared image/audio bridge limits; they are bridge
resource limits rather than claims about the maximum formats Desktop can handle.

`tests/entry.prepared-video-send.ts` verifies complete and absent thumbnails, immutable
validated metadata, duration/dimension bounds, unknown-key and secret-field rejection,
token validation and incomplete thumbnail rejection. It passes, and TypeScript passes.
The worker command and controller wiring described below preserve atomic token ownership
and the existing durable ID barrier before any local send.

The pinned controller patch now adds `SendStoredVideoInformation` and
`sendPreparedVideoWithIds`. It validates and snapshots metadata before awaiting receiver
lookup, checks current group membership, claims primary/optional thumbnail tokens together,
constructs a native video fragment and uses the existing `_sendFragmentsWithIds` barrier.
Tokens transfer only after successful sending; errors after claiming retain uncertain handles.
Worker-local metadata validation also rejects empty video handles and invalid thumbnail
handle size or aliasing. Patch source and SHA-256 records are updated in
`integrations/threema/patches/send-ids.json`, and upstream preparation verification passes.

`tests/entry.prepared-video-controller.ts` invokes the real patched controller through its
endpoint proxy and real encrypted storage registry. Both thumbnail/no-thumbnail cases pass:
wrong-chat and malformed metadata rejection, missing thumbnail token without primary-token
consumption, duration/dimension/handle preservation, no local message before ID persistence,
single token use and failed-persistence retention. Ten existing prepared-file/image tests
also pass. The headless bundle rebuild and both root/upstream TypeScript checks pass.
These changes are newer than Linux v36.

The IPC route is now connected: `BackendController.sendPreparedVideo` validates the command
and creates an allocation channel; `entry.backend-worker.ts` parses the video command and
routes allocation callbacks through `SendAllocation`; the headless session invokes
`sendNodePreparedVideo`. The adapter validates scalar metadata and optional thumbnail fields,
checks profile ownership/current group membership, then forwards only tokens and metadata
through the controller proxy. It snapshots request fields before asynchronous lookup.

Both video controller cases now exercise the outer command parser, actual allocation port,
headless adapter, real endpoint proxy and native controller/storage registry. Persisted
string IDs match returned IDs and precede the local message. Adapter profile/duration
rejection is tested as well. The test substitutes the outer worker-request transport with an
in-process dispatch to the real adapter; dedicated-worker lifecycle tests run separately.
All 17 focused prepared-video/file/image and backend lifecycle tests pass. The bundle builds
with 789 modules; both TypeScript checks and upstream verification pass. Live video sending,
a dedicated-worker video integration fixture and fresh Linux builds remain unverified.

Outbox schema 13 adds immutable video projections before ID allocation. Native videos retain
prepared size, filename, MIME, duration, dimensions, caption and complete optional thumbnail
metadata; conversion fallback retains generic-file kind and actual output metadata. No worker
tokens or keys enter this table. Dispatch validates the command against the projection,
rechecks authorization, and records the projection before invoking the allocation barrier.
Echo reconciliation checks the canonical output and binds the original Matrix event before
marking the message observed. Uncertain sends remain excluded from automatic retries.

`tests/entry.video-outbox.ts` covers migration from schema 12 with a pending request,
thumbnail/no-thumbnail/file fallback, pre-send metadata conflicts and cleanup, immutable
projections, IDs persisted before simulated send failure, reopen with no retry, conflicting
echo rejection and idempotent matching echo recovery. Parser tests cover incomplete thumbnails,
secret fields, invalid byte/dimension/duration bounds. These are synthetic dispatcher/storage
fixtures, not codec or live-account evidence. Production video admission remains disabled.

The Linux encoder foundation now includes source-built OpenH264 2.6.0; see
[OPENH264-BUILD.md](OPENH264-BUILD.md) for exact image/test evidence. This adds the required
codec without yet enabling outbound video preparation.

`scripts/entry.video-renderer-probe.ts` extracts the actual pinned video conversion and
thumbnail helpers via TypeScript AST and runs them in secure-context Electron 40.10.0 /
Chromium 144.0.7559.236 with Mediabunny 1.34.4. Four synthetic fixtures succeed: AVC with
B-frames, AVC/AAC, AVC without B-frames and VP9/WebM. All produce AVC/MP4 and JPEG thumbnails;
the audiovisual case retains AAC. Exact synthetic input bytes/hashes and Desktop duration
results are committed in `tests/fixtures/video-timelines.json`. The complete local renderer
report is `.local/renderer-video-report.json`.

This probe exposes two important timing requirements before implementing preparation:
AVC with B-frames starts at 1/3 second and reports source duration 1.3333333333333335 seconds,
while converted video starts at zero and lasts one second. With an AAC track starting at
zero, the same video's 1/3-second offset remains. AVC without B-frames reports one second.
For VP9/WebM, Desktop reports 0.999666666 seconds, while the current FFprobe packet-duration
inspector returns 0.999 seconds (and differs by a floating-point rounding unit for AVC).
Therefore the existing audio timeline inspector cannot be claimed to reproduce video source
durations exactly. The video path still needs container/default-frame-duration handling,
track-preserving conversion, source disposal/fallback and thumbnail/staging integration.
The initial offset fixture was discarded because the MP4 muxer normalized it into a duplicate;
the committed distinct fixture uses no B-frames instead.


Verified ciphertext attachments now expose bounded random access: at most 1 MiB per read
and four concurrent reads, with AES-CTR counter adjustment for arbitrary byte offsets.
Reads reject invalid ranges/truncation/counter overflow and recheck cancellation/disposal
before returning plaintext. Disposal waits for active range reads to close, then erases the
key and removes the ciphertext spool. Encryption keys and storage paths remain private.
The tests cover unaligned boundaries, low-counter carry, concurrency and byte limits,
cancellation/disposal races and truncated storage, alongside existing streaming/staging tests.

`tests/entry.video-source.ts` feeds these reads to the pinned Mediabunny StreamSource for the
four committed synthetic videos. Node parses all source durations/first timestamps exactly
as the renderer does, including VP9/WebM, and returns 64x48 dimensions and the correct audio
track count. It checks that disk contents remain ciphertext and are removed afterward.
This establishes the parser/source combination, not a production-safe metadata worker:
the fixture runs the parser in-process on known synthetic bytes. Untrusted metadata parsing
still needs process memory/CPU/read budgets and cancellation before production integration.
These changes are newer than v37; the stager now includes Mediabunny and the source fixture
for the next Linux context.


`src/media/video-inspector.ts` now uses the existing native-limited codec process runner to
launch a separate Node child with a 64 MiB old-generation heap and `--jitless`. The child
uses Desktop's pinned pure container parser; parent/child communicate via bounded JSON lines.
Read requests are sequential, strictly validated, at most 64 KiB each, with a configured
aggregate limit (at most 256 MiB) and at most 65,536 requests. Output is capped at 8 MiB,
individual lines at 64 KiB; the parser cache is 1 MiB. Source bytes, duration/first timestamps,
all track types/codecs, audio properties, dimensions and rotations are validated before
returning metadata. Encryption keys and ciphertext paths stay in the parent. The caller
retains source ownership for subsequent preparation or fallback.

The TypeScript inspector is bundled by `prepare:video-inspector` because Node 24's built-in
TypeScript stripping requires WebAssembly, unavailable with `--jitless`. The bundle manifest
records all 61 imported source hashes and the output hash; Linux staging rejects stale inputs.
The source remains TypeScript; the isolated executable is its generated JavaScript bundle.

Four local tests pass: exact encrypted-range parsing for all four video fixtures, source
corruption/read-budget/length/failure/cancellation/timeout behavior, invalid protocol fields
and oversized/out-of-bounds requests, confirmed termination of a stalled child, and complete
metadata validation. These local tests use a launcher shim; native memory/CPU limits require
Linux verification. This process is a resource boundary, not a filesystem/network sandbox;
deployment supplies network/filesystem isolation. It is not yet connected to conversion or
production video admission.

Context v38 (`a2bf33650093df53cc9672cd0924c5242c567f703a25328ec2904dffc6b43619`)
contains this inspector, its generated bundle, the pinned Mediabunny dependency and all
video source/inspector fixtures. Both service images built successfully:
- ARM64: `sha256:6ca77b026ff327f971bfc9eef93acce928bf0a3ef72ae40934707465a73a60c4`
  (`threema-beeper-service:video-inspector-arm64`).
- AMD64: `sha256:75a0f76946f060e5540a7bf82e4165e54e6168efad50e91aa03c9e2277945e80`
  (`threema-beeper-service:video-inspector-amd64`).

Four embedded inspector/source tests pass on each architecture: exact metadata from encrypted
ranges, bounded/cancelled/corrupt source behavior, hostile protocol requests and stalled-child
termination, and metadata validation. The protocol fixture deliberately substitutes a fake
child and launcher to test orchestration; the actual parser/source cases use media-limits.
Containers run offline, read-only, capability-dropped, with 768 MiB memory and 64 MiB tmpfs;
no source or test files are mounted from the host.

ARM64 initially failed at 512 MiB RLIMIT_AS before Node executed any application code.
A minimal `node --jitless --max-old-space-size=64` reproduces the V8 segmented-table allocation
failure. Without that ceiling, the minimal process reports VmSize 612744 KiB and VmRSS 39932
KiB. At a 768 MiB address-space ceiling the complete inspector cases pass. This is a measured
Node-specific ceiling; it does not change FFmpeg's 512 MiB ARM64 limits. Emulated AMD64 passes
with the existing 4 GiB address-space ceiling; native AMD64 at 768 MiB remains unverified.
Logs: `.local/linux-video-inspector-arm64-test-768m.log` and
`.local/linux-video-inspector-amd64-test.log`; the initial failing ARM64 log is retained.
The root TypeScript check also passes. Video conversion, thumbnails and staging remain next.


`src/media/video-preparation.ts` now owns the verified source through isolated metadata
inspection, full decoding of every AV track, MP4 conversion, output metadata validation and
source cleanup. Compatible AVC/AAC tracks are copied; other video/audio tracks use pinned
OpenH264/AAC encoders. Video bitrate follows pinned Mediabunny QUALITY_HIGH's AVC pixel-based
formula; AAC uses 192000 bps. No user-selected quality preset is invented. Output writes
directly into the ciphertext spool. Duration metadata retains the exact Desktop source
value, while conversion subtracts the global first timestamp. Codec and inspection
cancellation signals are combined, and failed cleanup has a distinct terminal error type.

FFmpeg's negative composition-offset flag is needed to normalize the video-only B-frame
fixture, but shifts the video in the audiovisual fixture if used unconditionally. Preparation
uses it when all video tracks start at the global source start, and then validates the actual
output. It rejects changes to AV track count, codec, display geometry/rotation, audio sample
rate/channel count, or per-track start timing beyond 1 ms container quantization tolerance.
This is verified for the committed fixtures; broader edit-list, multi-video-track, rotation,
resampling and unusual-container behavior remains to be tested and implemented. Seek-dependent
containers that FFmpeg cannot consume from a pipe also need further work. Only metadata,
not a second full decode of generated output, is checked after encoding at this stage.

Context v40: `135d1597eaeedfa0715aba585e3f177e863de5733ccff0b3a36c4e65cff97bcf`.
The earlier v39 staging snapshot was superseded before building to combine cancellation
signals and add failure tests. Both v40 service images build and pass eleven embedded tests:
- ARM64 `sha256:1178f3bd7204e4f496b63ae4135b4af1448b5546dce2a72c9576104de54bc735`
  (`threema-beeper-service:video-preparation-arm64`).
- AMD64 `sha256:edac894bd7e3550a40e17248db9f43b6c958c7872a6484b0dd0f2edd9c3f7764`
  (`threema-beeper-service:video-preparation-amd64`).

The suite includes four actual prepared-video fixtures (AVC, AVC/AAC, no-B-frame AVC and
VP9-to-AVC), cancellation in either inspection/codec stage, oversized-output cleanup,
terminal cleanup failure, four durable video recovery/projection tests and two verified
ciphertext-range tests. Native ARM64 uses 512 MiB codec and 768 MiB inspector address-space
ceilings; emulated AMD64 uses 4 GiB for both. Containers remain offline/read-only/capability-
dropped with 768 MiB memory and 64 MiB tmpfs, and execute embedded sources/tests without
host mounts. Logs are `.local/linux-video-preparation-{arm64,amd64}-{build,test}.log`.
Four local AVC/failure tests and TypeScript also pass; Homebrew lacks OpenH264, so the VP9
conversion is proved using the pinned Linux images. This is not live/mobile playback proof.


`prepareVideoWithFallback` now borrows the verified source during conversion. If conversion
fails, the caller receives the unchanged original attachment, original MIME and actual size
for generic-file sending, provided it fits the output limit. Successful conversion disposes
the source before returning the MP4. Cancellation from either codec or inspection and cleanup
failures are terminal; they do not silently select the original file. Failed cleanup after a
successful conversion also disposes its generated output rather than returning it.

`createVideoStaging` converts either result into an opaque worker token and canonical video
or file projection. Native video uses a generated MP4 filename; fallback preserves the original
filename/MIME and never adds video duration/dimensions or audio-duration fields. It verifies
metadata against attachment size before allocation and disposes the local spool before
handoff. Failed worker-token and local-spool cleanup remain in a per-request set, including
cleanup that fails while another failure is already retained. A retry drains those resources
before allocating another token. This stage currently supplies only the primary token;
thumbnail bundles and profile download/dispatch integration remain unfinished.

Context v41: `b032e536b6a77d881c86b5fd0345639d857f38c09422bcbfe3cc56455049b56a`.
Both images pass fourteen embedded fallback/staging/conversion/recovery tests:
- ARM64 `sha256:15a60de0809ddcc7418c130a21ee9ca2d67383a4bd9f58f3c0aa94577047cf70`
  (`threema-beeper-service:video-fallback-arm64`).
- AMD64 `sha256:a9f0a7f37b9c0620daa6cc4c11861a526abf3a1cf7aaa413c30e6f0d83d99dd7`
  (`threema-beeper-service:video-fallback-amd64`).

Fallback tests execute real AVC conversion and exercise unavailable-codec fallback, original
ownership/byte preservation, output bounds, cancellation in either stage and terminal source
cleanup failure. Staging tests substitute the worker API to verify streamed bytes, opaque
commands, metadata kinds, retained cleanup, size conflicts and cancellation after allocation;
they do not establish a complete dedicated-worker video integration. Conversion and durable
recovery tests continue to pass. Nine corresponding local tests and TypeScript pass. Linux
runs use the same offline/read-only/capability-dropped containers and codec/inspector limits
as v40; no host sources or tests are mounted. Logs are
`.local/linux-video-fallback-{arm64,amd64}-{build,test}.log`.

Thumbnail fidelity note for the next stage: the actual outbound UI's `generateThumbnail`
uses `generateVideoThumbnail` at **10%** of source duration, JPEG quality **0.8**, then passes
that JPEG through `downsizeImage` with maximum dimension **512** and quality **0.8**. The prior
renderer video probe deliberately requested 0% and only tested the first helper. Its thumbnail
output is not evidence for the complete outbound thumbnail path. Sampling and the second
encode/resize need their own renderer fixture and native implementation.


The complete outbound thumbnail renderer path is now captured by
`scripts/entry.video-thumbnail-renderer-probe.ts --write-fixtures`. It extracts the actual
pinned UI `generateThumbnail`, `generateVideoThumbnail`, conversion validation helpers and
`downsizeImage`; image-only branching is excluded because every fixture is a video. It checks
JPEG/0.8/512 constants and runs secure-context Electron 40.10.0. Six synthetic inputs and
exact selected-frame/final-JPEG/pixel results are committed in
`tests/fixtures/video-thumbnails.json` with source/input/output hashes and compressed RGBA.
These include 640x360 -> 512x288 resizing and a four-second video whose 10% target is 0.4 s
but whose selected frame starts at 1/3 s.

Contrary to the comment in Desktop's video helper, the pinned `VideoSampleSink.samples`
implementation retains the last sample at or before the target, or the first sample if the
target precedes the video track. This was observed in the renderer and confirmed in
`media-sink.ts`'s range iterator. The isolated inspector now optionally returns a validated
primary-track thumbnail timestamp using the pinned encoded-packet lookup. All six sample
choices match the renderer. The optional result is range/type checked in both processes,
and existing metadata-only callers continue to receive no thumbnail field.

`src/media/video-thumbnail.ts` now borrows the verified video, extracts the chosen frame
under codec limits, and performs two JPEG quality-80 encodes with a final maximum dimension
of 512. Frame/intermediate JPEG storage is ciphertext only and is discarded before returning
the thumbnail. The source remains owned by the caller. Cancellation is shared across parser,
frame extraction and JPEG stages. This is not yet integrated into the video fallback bundle
or worker staging, and no fresh Linux image includes these changes yet (latest v41 predates
them). Ten local inspector/source/thumbnail tests and TypeScript pass.

Pixel parity remains incomplete. Initial frame comparisons isolated differences in FFmpeg's
chroma interpolation and color defaults. Bilinear/full-chroma/accurate-rounding interpolation
is now explicit. For the 64x48 AVC fixture, a BT.709 matrix plus that interpolation differs
from the renderer's selected RGBA by at most one channel unit; the VP9 fixture instead needs
BT.601 for the same result. The actual renderer reports BT.709 for the small AVC clips but
SMPTE170M for the 640x360 AVC clip, and unspecified color fields for VP9. Therefore no universal
AVC color-matrix override was applied. The committed fixture records these actual color-space
values. Correct declared/default color handling, JPEG decoding and resize differences still
need resolution before claiming Desktop-matching pixels. Functional tests verify sampling,
dimensions, bounds and encrypted storage; they deliberately do not claim pixel equality.


Optional thumbnails are now integrated into `prepareVideoWithFallback` and
`createVideoStaging`. A configured thumbnail is prepared from the original verified source
before conversion. Ordinary extraction failure permits a native video without a thumbnail;
cancellation or cleanup failure terminates preparation. If conversion selects the original
file, any generated thumbnail is disposed and no thumbnail metadata is returned. Successful
native-video handoff includes the thumbnail attachment after original-source disposal.

Staging validates both attachment sizes and thumbnail metadata, prepares distinct worker
tokens, and includes the complete optional thumbnail fields in both the send command and
immutable projection. Failure after preparing only the main token discards it and both local
spools. Each spool and token has independently retained cleanup; retries clear failed cleanup
before new preparation. Successful handoff disposes both local spools, leaving token ownership
for the native controller's existing atomic claim/send barrier.

Context v42: `1fdf8bba3166a070bc9c771f728292de2b5559a4682fc12dbf70fb3b48f82590`.
Both images build and pass twenty-seven embedded tests:
- ARM64 `sha256:71d9fe6bd06b82fa00c1c4589e4da87e405eb1a045ee889c886867108180f57e`
  (`threema-beeper-service:video-thumbnail-arm64`).
- AMD64 `sha256:7660280a110821c4a39a2a55a73b39442ef334dfa5fcf5b9276bccf67a27a44b`
  (`threema-beeper-service:video-thumbnail-amd64`).

The suite covers six thumbnail fixtures, isolated inspection/protocol limits, encrypted-range
reads, four conversion fixtures, optional thumbnail failure, successful extraction followed
by rejected MP4 conversion, original-file fallback, partial two-token staging failure, retained
cleanup and durable echo recovery. Tests run with concurrency two inside offline/read-only/
capability-dropped containers, 768 MiB container memory and 64 MiB tmpfs. ARM64 uses 512 MiB
codec and 768 MiB Node-inspector address-space limits; emulated AMD64 uses 4 GiB ceilings.
No host sources or tests are mounted. Logs are
`.local/linux-video-thumbnail-{arm64,amd64}-{build,test}.log`. Ten local fallback/staging/outbox
tests and TypeScript pass as well.

Staging tests still substitute the worker preparation API; native controller/proxy atomic
claims were verified separately. Pixel equality is not asserted, and the previously recorded
color/resize differences remain open. Thumbnail preparation is optional configuration and
not enabled by production service startup. Profile download/dispatch wiring remains next.


## Profile download and runtime integration

`createVideoPreparation` in `src/media/video-download.ts` connects authenticated Matrix
attachment download to conversion/fallback and token staging. The original is downloaded
and hash-verified once per attempt; thumbnail extraction and conversion share that source.
The profile cancellation signal covers limit discovery, download, inspection, codecs and
worker staging. Failed source or worker-token cleanup is retried before another download.
`createVideoStaging.clearPending` exposes its retained cleanup for this preflight step.

`ProfileRuntime.files.createVideoPreparation` now opts the profile into video preparation;
configuration requires native `sendPreparedVideo` support and existing media echo rendering.
The profile forwards the factory and sender to `createMediaRuntime`, whose ingress and
unsupported-notice consumer share `videosEnabled`. Enabled video MIME attachments enter
the durable media queue. Replies and mismatched MIME attachments still receive unsupported
notices. The production launcher does not yet configure this factory.

Sixteen local tests pass across video download, staging, durable outbox, media ingress,
media runtime and profile lifecycle; root TypeScript passes. The new download test uses a
synthetic authenticated Matrix transport, committed AVC fixture, real local FFmpeg and the
isolated inspector. It verifies conversion, original fallback, rejection of tampered ciphertext
before worker staging, retained-token cleanup before redownload and pre-download cancellation.
Runtime tests verify video routing, durable projection before native invocation, persisted IDs,
source ordering, authorization revocation after preparation and shared shutdown cancellation.
Worker preparation/sending is substituted in these integration tests; no live account is used.

The runtime changes are now verified in fresh Linux images, as recorded below. A combined
dedicated-worker fixture, broader format/playback validation and thumbnail color/resize
parity remain open.


## Linux runtime verification (v43)

Context SHA-256: `e4442870f7fd6f8dc0683c663f143c716a5b87c87633eb3dd5e38c3537a17065`.
The stager now explicitly includes video download, media ingress/runtime and profile lifecycle
tests, alongside the existing video fixtures and tests. It stages 225 packages and verifies
the inspector bundle's input hashes before building.

- ARM64 image `threema-beeper-service:video-runtime-arm64`:
  `sha256:c791d6b753b18aa860054294cc48ea07cdc42ccce6df2cde1be06686addaf1fa`.
- AMD64 image `threema-beeper-service:video-runtime-amd64`:
  `sha256:e0fe14f122ec07009ef63a0073604706dbde70e55c5e5bd3a858ce3b2f275823`.

Both builds complete successfully. Both images pass all 36 embedded tests with concurrency
two: video download, media ingress, media runtime, profile runtime, video thumbnails,
isolated inspection, source metadata, fallback, staging, durable outbox, conversion,
authenticated attachment range reads and native prepared-video controller. ARM64 completes
in 11.22 seconds; emulated AMD64 in 34.92 seconds. Root TypeScript also passes.

Containers use no network, a read-only root filesystem, no capabilities, no-new-privileges,
768 MiB memory and a 64 MiB executable tmpfs. No host sources/tests are mounted. Native ARM64
codec address space is limited to 512 MiB and the inspector to 768 MiB; emulated AMD64 uses
4 GiB address-space ceilings for both. These are pinned FFmpeg 8.0.3 builds.

Logs: `.local/linux-video-runtime-{arm64,amd64}-{build,test}.log`.

This evidence combines the runtime suite and native controller suite in the same image; it
does not claim one continuous dedicated-worker send. The controller suite still substitutes
`BackendController.request` while exercising actual MessagePort allocation persistence and
the native controller/proxy. The production worker loads `createNodeSession` directly and
requires an opened profile for preparation. A synthetic session fixture must exercise that
worker route without a paired account; a missing-identity rejection alone would not establish
successful main/thumbnail handoff. Production admission remains disabled.


## Dedicated-worker integration

`backend-session-router.ts` now owns the production command router and exported native-session
interface. `entry.backend-worker.ts` still acquires the profile lock, loads the pinned native
bundle, probes it and creates the real session; it then starts the shared router. The
`BackendController` constructor accepts a code-level worker factory for fixtures, defaulting
to the original worker entry. No service configuration or environment switch selects a
synthetic session.

`tests/fixtures/video-session-worker.ts` runs that same router in an actual worker thread.
Only its profile/model state and final local-message observer are synthetic. It uses the
pinned native prepared-file registry, encrypted file storage, conversation controller,
endpoint proxy and `sendNodePreparedVideo`. The parent uses an actual `BackendController`,
including its request map, transferable ports, streaming credits and allocation acknowledgment.

`tests/entry.video-worker.ts` verifies:
- Main and thumbnail bytes match their committed fixture hashes and survive staging, worker
  transfer and native encrypted storage; the native local-message observer reloads and hashes
  both handles.
- Withheld persistence acknowledgment prevents any local message. Acknowledgment permits it.
- Transferred tokens cannot be reused. A rejected persistence callback leaves claimed tokens
  unusable and creates no local message.
- One synthetic authenticated Matrix download feeds real conversion and optional thumbnail
  generation, then real worker preparation and native send. Hashes captured as each prepared
  stream enters the worker match hashes loaded by the native controller; duration and dimensions
  match the prepared command.

The fixture's persistence callback exercises the barrier but does not open a durable journal;
SQLCipher journal/restart behavior remains covered by the separate outbox tests. It does not
pair or send over Threema's network. Nine focused local tests (combined worker, native controller,
production worker lifecycle and shutdown) pass, as does TypeScript. Thumbnail extraction initially
fell back because the fixture supplied a relative JPEG executable; the corrected fixture supplies
an absolute path, as required by the codec launcher, and asserts that a thumbnail was produced.


Linux context v44: `ec38329a1c8b055a33d714c0b9bf317ee02f69a568ce0ad7e08110d11c02e4c3`.
Both fresh images build and pass all 43 embedded tests, including the new continuous worker
path plus production worker lifecycle/shutdown and the entire v43 suite:
- ARM64 `threema-beeper-service:video-worker-arm64`:
  `sha256:43cec333ef596a6ddf15c1b81d7263f3c7a71ec9ca2b9eb91546b911a3c2db93`.
- AMD64 `threema-beeper-service:video-worker-amd64`:
  `sha256:f89437b03c6804b8f9da50c9aa306116ea3a3226aa598ea8e48019e885ba7514`.

The suite takes 13.58 seconds on native ARM64 and 39.74 seconds on emulated AMD64. Runs retain
v43's offline/read-only/capability-dropped container settings, concurrency two, 768 MiB memory,
64 MiB tmpfs, 512/768 MiB ARM64 codec/inspector address-space limits and 4 GiB emulated AMD64
limits. No host test/source mounts are used. Logs:
`.local/linux-video-worker-{arm64,amd64}-{build,test}.log`.

Successful network submission, full profile/model/database integration, broader video formats,
output playback and thumbnail pixel parity are not established by this fixture. Production
video admission remains disabled.


## Generated-output decoding and desktop playback (v45)

Preparation now fully decodes the generated MP4 after metadata/track validation and before
source disposal or handoff. The same bounded all-track FFmpeg validation is applied to source
and output. Output validation uses the configured output-byte ceiling as its input limit,
retains CPU/address-space/deadline/cancellation limits, and discards decoded frames/audio
without plaintext spooling. This closes the gap where valid container metadata could conceal
undecodable encoded samples.

The regression creates a valid converted MP4, zeroes only its mdat payloads and confirms that
isolated metadata inspection still accepts its AVC track. A synthetic encoder returns those
bytes while preserving the real source decode. Preparation rejects the corrupt output and
disposes both provisional output and source. The three local AVC fixtures plus this failure
suite pass; root TypeScript passes. Host FFmpeg lacks OpenH264, so VP9 conversion is tested
in Linux rather than inferred from host results.

Context v45: `81b7f83dbb81b172b1a16f1f5a1b4a2f9723d00151fe922b66b791f8a2e585ef`.
Both images build and pass 17 affected tests (conversion including corrupted output, fallback,
download, staging, durable outbox and continuous dedicated-worker send):
- ARM64 `threema-beeper-service:video-decode-arm64`:
  `sha256:0a39da9c0de4ce7dc310a5dfdf3554254cd08bb124cb9dd8448521b7517f3d3d`.
- AMD64 `threema-beeper-service:video-decode-amd64`:
  `sha256:d4102375845cab817749de849b6cf2883d4be52d0119ec9717543ca7f66c62b0`.

Tests take 8.69 seconds on ARM64 and 25.82 seconds on emulated AMD64. Offline/read-only,
capability-dropped, no-new-privileges containers use the same memory/tmpfs/address-space limits
as v44, with embedded sources/tests and concurrency two. Build/test logs:
`.local/linux-video-decode-{arm64,amd64}-{build,test}.log`.

`scripts/entry.video-playback-probe.ts --generate-only` produces four converted fixtures per
architecture in those exact images, recording byte hashes and the Linux FFmpeg 8.0.3 producer.
`--fixtures FILE REPORT` verifies hashes and plays the supplied bytes in an isolated macOS
Electron 40.10.0 / Chromium 144.0.7559.236 renderer. All eight play to their ended event with
six decoded video frames and dimensions 64x48. Element durations on both architectures:
AVC 1.166667 s, AVC/AAC 1.333333 s, AVC without B-frames 1 s, VP9-to-AVC 1 s. AAC is independently
decoded through OfflineAudioContext: 1.0213333333333334 s with peak 0.15697823464870453.
This records actual playback duration rather than equating it to canonical source duration.

Artifacts: `.local/linux-video-playback-{arm64,amd64}-fixtures.json`, corresponding
`-generate.log`, `-renderer.log` and `-report.json`. Both generator and renderer processes
complete successfully. The renderer uses a temporary profile and blocks external network
requests. No paired profile or real message is involved.

These four small source types establish desktop playback only for those fixtures. Android/iOS,
large or seek-dependent inputs, additional tracks/rotation/edit lists, color/thumbnail parity
and full profile/network integration remain outstanding. Production video admission stays off.


## Rotation and multiple-track validation

`tests/entry.video-geometry.ts` derives six cases from hash-verified committed source fixtures:
AVC display rotation at 90/180/270 degrees, two AVC video tracks, AVC with two AAC audio tracks,
and rotated VP9 remuxed to MP4 then converted to AVC. Rotation is set via FFmpeg's input
`-display_rotation` option; the older rotate metadata setting alone was ignored by host FFmpeg
9.0.1. Tests assert input rotation and swapped display dimensions before conversion, so an
unrotated fixture cannot falsely establish support. They then verify canonical source duration,
all track types, output codecs, each video's display dimensions/rotation, and each audio track's
sample rate/channels. Generated output is also subject to the production full-decode check.

The five AVC cases pass locally. Linux context v46
`a17eec5194e1f58f03151abcd1195d308df16d8390a72867189aa4f88dbb915d` exposed an ARM64-specific
failure in the two-AAC case: 10/11 tests passed, while emulated AMD64 passed 11/11. Temporary
diagnostic copies mounted only for this synthetic reproduction revealed
`pthread_create() failed: Resource temporarily unavailable` during source validation, caused
by concurrent decode/filter stream thread allocation under the 512 MiB address-space ceiling.
Production parser diagnostics remain suppressed.

Validation now decodes each track sequentially. All track passes share one original codec
wall-clock deadline, while each process retains CPU, address-space, input-byte and output-byte
limits. Source and generated output both use this validation. This trades additional sequential
reads of the encrypted spool for fewer concurrent thread stacks, without skipping audio or
raising the address-space ceiling. The corrected source mounted into the v46 ARM64 image passes
all 11 tests at the original limits (`.local/video-geometry-serial-validation.log`); TypeScript
passes. The diagnostic log is `.local/video-two-audio-diagnostic.log`.

These fixtures establish preservation of rotation metadata/display geometry and track content
through full decoder validation. They do not establish pixel-equivalent rotated thumbnails,
all edit-list layouts, all track combinations, or mobile playback.


Fresh corrected context v47:
`32d63102260bb59307ee9fa6ac0e21cdd9ab6c51b8d488ca15bb563d639d58e4`.
Both images build successfully:
- ARM64 `threema-beeper-service:video-track-decode-arm64`:
  `sha256:f27136342a3d2b0bb55e59e09bdbd48230694c38107b1f665aa3e7e724ba63e3`.
- AMD64 `threema-beeper-service:video-track-decode-amd64`:
  `sha256:1fdcb3a2b784ed750b6d00e846697a4937b6e0b8072f736518762ae9dc408f1e`.

The regression run includes geometry/track fixtures, original conversion/corruption fixtures,
fallback, authenticated download and the combined dedicated worker. It uses embedded tests
without host mounts; containers retain the offline/read-only/capability-dropped configuration,
768 MiB container memory, 64 MiB tmpfs and existing codec/inspector address-space limits.
Logs: `.local/linux-video-track-decode-{arm64,amd64}-{build,test}.log`.

Both architectures pass all 14 tests, including rotated VP9 conversion and the previously
failing two-AAC case. Native ARM64 completes in 12.11 seconds; the exact emulated AMD64
duration is recorded in its test log. Production video admission remains disabled.
