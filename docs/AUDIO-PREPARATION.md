# Outbound audio preparation in progress

The handoff requires Matrix audio/voice sending with MIME and duration preserved. The
pinned Desktop controller calls `transcodeAudioAndSetProperties`: AAC in MP4 becomes a
native audio message; if AAC fails, Opus in MP4 becomes a file; if that also fails, the
original file is sent. Desktop derives duration from `input.computeDuration()` and uses
a generated timestamped `.m4a` filename. These behaviors are defined in the pinned
`common/viewmodel/conversation/main/controller/helpers.ts` and `common/utils/audio.ts`.

`src/media/audio-duration.ts` implements the first bounded native preparation component.
It selects the first audio track and decodes through FFmpeg into mono 48 kHz signed
16-bit samples, counting bytes in a discard sink. It stores no PCM and takes no Matrix
duration value. Existing codec CPU, memory, input, output and wall-time limits apply;
decoded bytes additionally enforce a caller-specified duration cap of 1–10000 seconds.
Errors, incomplete source delivery and cancellation reject the result. It does not stop
at the cap and accept a truncated duration. The 10000-second ceiling keeps the counting
stream below the existing 1 GiB codec output bound; this is a configurable resource limit,
not an assertion about the format's maximum duration.

The local test verifies 0.25-second WAV at 48 kHz mono and 44.1 kHz stereo, FLAC stereo,
and rejection for corruption, duration/input overflow, invalid limits, late input errors,
cancellation and timeout. WAV fixture RIFF/data lengths are finalized in memory because
FFmpeg's pipe writer otherwise emits unknown lengths that strict decoding rejects.

This component measures decoded sample duration, not arbitrary container presentation
timelines. Timestamp gaps, edit lists, codec delay/padding, multiprogram selection,
additional input codecs and Linux execution still need validation against Desktop's
duration behavior. Opus fallback, prepared-audio worker
commands, durable projection/echo handling and production admission remain unimplemented.
The duration helper alone must not be treated as a completed audio-send path.

Local regression and TypeScript checks pass. Linux context v29 is
`3cbac8cecebfa38db0b1893152a60c21c9b5d59b66d2474a90867f639881307f`.
Builds started as `threema-beeper-service:audio-duration-{arm64,amd64}`, with logs
`.local/linux-audio-duration-{arm64,amd64}-build.log`. Embedded Linux test runs are pending.

Both v29 builds completed and the embedded duration regression passes:

- ARM64: `sha256:b06181812c35e79ab2b7fba3168f86351fa4d178733a3dbf8aaee417dfe00413`
- AMD64: `sha256:36fe78abafcf9e57c8e274fadc6ef24072b692658a84480fa081bbe5f09c8a6e`

Runs used network-disabled read-only containers with no host mounts, dropped capabilities,
768 MiB container memory, and codec address-space bounds of 512 MiB on ARM64 / 4 GiB under
AMD64 emulation. Native AMD64 at the normal 512 MiB bound remains unverified.

`prepareAudioAttachment` now measures the verified source on its first read and encodes
the first audio track to AAC at 128 kbit/s on a second read. Encoded MP4 bytes stream
directly into the existing encrypted attachment spool. It removes source metadata and
chapters, omits non-audio tracks, verifies consumed bytes, and requires successful source
cleanup before handoff. Failure disposes provisional output and retries source cleanup.
The local regression verifies stereo AAC/48 kHz, full output decoding, source-duration
metadata, title removal, ciphertext-only spools, overflow, missing codecs, late source
failure and cleanup failure. TypeScript checks also pass.

The native muxer uses fragmented MP4 so it can write to a pipe without a plaintext
seekable file. This differs from Desktop's buffered muxer: mobile playback compatibility,
AAC encoder settings, priming/padding and source timeline parity still need verification.
The selected bitrate is provisional. Opus/original-file fallbacks and prepared-audio
worker/journal integration remain missing; production audio admission stays disabled.

The prepared-file worker path now accepts optional trusted `audioDurationSeconds` only
with `audio/mp4`, finite and greater than zero up to 10000 seconds. Without the field,
the existing generic-file path remains unchanged. Validation runs in the outer command
parser, headless adapter and Desktop controller before token claim; the stored fragment
path validates again before creating a native audio fragment with `duration` in seconds.
No file-storage keys or handles cross IPC. The existing send-ID recording callback must
complete before local message insertion, and the token transfers only on successful send.

Eleven local prepared-file/image tests pass after rebuilding the actual headless bundle.
The real proxy path test covers native audio insertion, exact fractional duration, ID
recording before insertion, one-time token consumption, and invalid duration/MIME rejection.
The source overlay/patch verifier and both TypeScript projects pass. Production audio
admission is still disabled: staging integration, immutable audio journal projection,
echo matching and fallback behavior must be completed before using this new capability.

v30 context: `8add72baf2f7435dcd40e226d2986c19ee56d594ad627b4623016c3f5d51e00b`.
Builds started as `threema-beeper-service:audio-aac-{arm64,amd64}`, with logs
`.local/linux-audio-aac-{arm64,amd64}-build.log`. AAC Linux runtime tests are pending.

Both v30 builds completed and both embedded audio-duration/AAC preparation cases pass:

- ARM64: `sha256:f7b4e566e4353887b62c5d5861c66cfe466c8ba0f7febf5ed89ec792e4afcb54`
- AMD64: `sha256:39c607746abc14f2dd874e25e5d3ecf1797c348d739201437f7367cacdecf750`

Tests use the same offline read-only container and architecture-specific address-space
limits as v29. These images predate the prepared-audio worker extension described above;
that extension needs a fresh Linux build. No build or test processes remain running.

## Durable audio dispatch and echoes

Outbox schema 11 adds `media_audio_projections`, storing only immutable output metadata:
filename, `audio/mp4`, encoded byte size, duration in seconds and optional caption. Tokens
and keys are rejected by the projection parser. The database doctor accepts schema 11;
schema 10 upgrades preserve pending requests and create the new table transactionally.

The dispatcher has an optional audio-preparation route. It validates prepared command
metadata against the projection, rechecks authorization, claims the request, persists the
projection and only then allows ID allocation. Audio ID allocation without a projection
is rejected. Ordinary file preparation cannot inject an audio duration and change the
message kind through the file route. Uncertain audio requests are not automatically retried.

Audio echoes must match owner/profile/chat/message ID and the stored output filename,
MIME, byte size, caption and exact duration. A matching echo binds the original Matrix
event before marking the outbox part observed. The regression exercises metadata mismatch
with zero sends, schema-10 migration, immutable projection writes, missing-projection
rejection, restart after ID allocation, conflicting echoes, and idempotent correct echoes.
Twelve focused journal/dispatcher/doctor/backup tests pass; the backup drill restores native
Matrix identity and room keys while preserving existing uncertain work. TypeScript passes.
The audio projection also participates in `tests/entry.backup-store-drill.ts`: a claimed
audio request, its immutable AAC output metadata, allocated message ID and portal binding
are saved through the real encrypted backup, restore and workspace adoption path. After
reopening and interrupted-work recovery, the request remains `OUTCOME_UNKNOWN` and is not
eligible for automatic dispatch. A changed-duration echo is rejected; the correct echo
settles the request and binds its original Matrix event idempotently. The expanded drill
passes locally alongside restoration of the native Matrix device identity and room keys.
This is synthetic bridge-state coverage; it does not prove live Threema profile restoration.

Authenticated audio staging now connects Matrix download verification, bounded AAC
preparation, encrypted output spooling and opaque worker tokens. Failed cleanup is retained
and retried before another download for that request. Regression coverage checks ciphertext
authentication failure before worker staging, cleanup retry and successful token disposal.
Profile runtime exposes an optional audio preparation factory; ingress and unsupported
notices share its admission flag. Audio remains disabled in the production launcher pending
format parity, fallback and fresh Linux validation. Replies and non-audio MIME types remain
unsupported by this route.

## Linux staging validation

Fresh context `v31` has SHA-256
`09526d1383275013236de07fc837a4a665be8da92ce18548fe50f777a08b9152`.
It includes the audio worker extension, schema 11 and authenticated audio staging.
Both service builds completed:

| Architecture | Image tag | Image SHA-256 |
| --- | --- | --- |
| ARM64 | `threema-beeper-service:audio-staging-arm64` | `b75c5c3e74aa6a97cb7f0f7f8f19e114d6413260812aed8ed42809575023bdd0` |
| AMD64 | `threema-beeper-service:audio-staging-amd64` | `7515e5ff598278b01b4d339210d6dfd1414f3bf6448dc07dac301d4f00aeb734` |

Nineteen tests passed on each image: audio duration, AAC preparation, authenticated
staging, durable audio projection/echo recovery, prepared-file worker/controller tests
(including audio fragments), media ingress and dispatch. The test directory was mounted
read-only because the worker/ingress/dispatch regressions are not embedded in context v31.
Application code, worker bundle, native libraries and codecs came from each built image.
Logs are `.local/linux-audio-staging-{arm64,amd64}-{build,test}.log`.

Containers used `--network none --read-only --cap-drop ALL`, `no-new-privileges`, a
768 MiB memory limit and a 64 MiB executable `/tmp` tmpfs. ARM64 codec address-space
limits were 512 MiB. Emulated AMD64 used 4 GiB address space while retaining the
768 MiB container limit; native AMD64 with the lower address-space limit remains unproven.
No accounts or live messages were involved. All four build/test processes completed.

This validates the implemented synthetic path, not Desktop duration/container parity,
mobile playback, AAC-to-Opus/original-file fallback or production audio readiness.

## Source timeline comparison

`pnpm run probe:audio-duration` generates seven synthetic files and compares the bridge's
bounded PCM counting sink with the pinned Desktop dependency, Mediabunny 1.34.4, using
`Input`, `ALL_FORMATS`, `BlobSource` and `input.computeDuration()`. Desktop calls that
method after conversion. The probe does not run conversion or claim browser codec support.
Mediabunny's `src/input.ts` defines this result as the largest end timestamp across all
tracks, rather than the decoded sample count of the first audio track.

Observed durations in seconds with local FFmpeg-generated fixtures:

| Source | Desktop demuxer | Bridge sample count |
| --- | ---: | ---: |
| 44.1 kHz WAV | 0.25 | 0.25 |
| FLAC | 0.25 | 0.25 |
| Ordinary AAC/MP4 | 0.25 | 0.25 |
| Fragmented AAC/MP4 | 0.2713333333333333 | 0.2773333333333333 |
| AAC/MP4 with 0.5 s offset | 0.75 | 0.2773333333333333 |
| AAC/MP4 with 0.5 s timestamp gap | 0.75 | 0.25 |
| AAC/MP4, 0.25 s and 0.75 s tracks | 0.75 | 0.25 |

The report at `.local/audio-duration-report.json` records fixture hashes and the Desktop
audio helper source hash. These are diagnostic mismatches, not passing parity assertions.
They demonstrate that the current duration calculation must be replaced or supplemented
with bounded source-timeline inspection before production audio admission. PCM decoding
still provides useful corruption and resource-limit validation. Output container timing
and conversion behavior need separate verification; changing the metadata alone does not
establish playback parity.

### Bounded packet timeline implementation

`src/media/audio-timeline.ts` now runs the trusted sibling `ffprobe` executable through
the existing CPU/address-space/time/input limits. It parses packet integer PTS/duration
and stream rational time bases incrementally, retaining at most 128 track accumulators
and one bounded line. Output is limited to 64 MiB; missing timing, duplicate time bases,
overlong records, excessive duration, source failure and cancellation reject inspection.
All seven comparison fixtures now exactly match the pinned demuxer's duration. The probe
asserts those equalities. The initial decimal-timestamp approach was replaced because
FFprobe's printed decimals lost precision for fragmented AAC.

Audio preparation now performs three authenticated source reads: bounded PCM validation,
packet timeline inspection and AAC encoding. Stored duration comes from the source
timeline. This preserves the existing corruption/resource checks and ciphertext-only
output staging. Tests cover cleanup on failure during either of the last two reads.
The timeline parser has adversarial transcript, bounds, timeout and cancellation tests;
the real FFprobe path is exercised by the seven-file comparison and preparation/staging
tests. Linux v31 predates this implementation and needs renewed validation. Broader format,
edit-list and output playback parity remain open, as does fallback handling.

### Linux timeline validation

Context v32 (`280067630dbf9c954b17988898000109387357a9b12b94a5e35309ce7432e6d1`)
includes the packet-timeline implementation and `tests/fixtures/audio-timelines.json`.
The reference fixture records seven exact synthetic input files, their hashes, the pinned
Mediabunny version/helper source hash and observed source durations. Regenerate explicitly
with `pnpm run probe:audio-duration --write-fixtures`.

Both fresh service images built and passed all six embedded audio tests, including exact
timeline equality for all seven containers, parser failure/cancellation cases, bounded
decoding, AAC preparation, authenticated staging and uncertain-outbox recovery. No host
test-directory mount was used. The real FFprobe cases use the source-built codec binary and
native limiter; the malformed-transcript cases use a synthetic child/launcher to exercise
the parser and process-control path.

| Architecture | Image tag | Image SHA-256 |
| --- | --- | --- |
| ARM64 | `threema-beeper-service:audio-timeline-arm64` | `4c3cc9473ef30ae8082e757dad3e3030af2b70c6c7a7ebfca4a91745216d14de` |
| AMD64 | `threema-beeper-service:audio-timeline-amd64` | `3f8ef1296df8681c1b9cc314a0f9f019b14e0812bd0d77ff808c602d0bba478b` |

Logs: `.local/linux-audio-timeline-{arm64,amd64}-{build,test}.log`. All processes completed.
Containers used the v31 offline/read-only/capability restrictions and 768 MiB memory limit.
Real ARM64 codec processes used 512 MiB address space; emulated AMD64 used 4 GiB. This does
not establish the lower limit on native AMD64, broader timeline parity or mobile playback.
Production audio remains disabled. Local TypeScript checks also pass.

## Actual renderer conversion comparison

`pnpm run probe:audio-renderer` extracts the three audio transcoding functions from the
pinned Desktop source, bundles them with its installed Mediabunny dependency, and executes
them in Electron 40.10.0 / Chromium 144.0.7559.236. The harness uses a temporary profile,
blocked HTTP/WS requests and a local privileged secure protocol so WebCodecs are available.
It asserts secure-context, AudioDecoder and AudioEncoder availability. The initial data-URL
run lacked those APIs and is not evidence of Desktop fallback behavior.

All seven synthetic sources converted with AAC in the secure renderer. Source duration
metadata matches the bridge for all seven. Output timing does not:

| Source | Desktop output timeline (s) | Bridge output timeline (s) |
| --- | ---: | ---: |
| WAV 44.1 kHz | 0.3250793650793651 | 0.27321995464852605 |
| FLAC | 0.32 | 0.2713333333333333 |
| Ordinary AAC/MP4 | 0.32 | 0.2713333333333333 |
| Fragmented AAC | 0.2713333333333333 | 0.2986666666666667 |
| AAC offset | 0.2713333333333333 | 0.2986666666666667 |
| AAC timestamp gap | 0.32 | 0.7713333333333333 |
| Two AAC tracks | 0.832 | 0.2713333333333333 |

The two-track Desktop output retains both audio tracks; the current bridge emits only the
first. The gap fixture loses its discontinuity in Desktop output while the bridge preserves
it. Pinned Mediabunny `conversion.ts` also has a conditional encoded-packet copy path when
codec/sample parameters allow it; unconditional bridge re-encoding does not match that
decision. Encoder delay/padding differs as well. These findings require changes to track
selection, timestamp normalization and remux/transcode selection, not source duration alone.
The report `.local/renderer-audio-report.json` includes output bytes, codec capabilities,
source helper hash, stream metadata, timelines and decoded first-track sample counts.
This is an executed comparison with observed differences, not a passing playback-parity test.

### Re-encoding track and gap correction

Audio preparation now maps all audio tracks (`0:a`) and applies a continuous decoded sample
clock (`asetpts=N/SR/TB`) to each re-encoded stream. The source-timeline duration is unchanged.
The regression uses the exact gap and two-track reference containers, verifies AAC stream
counts, fully decodes each output audio track, checks both original sample lengths within
the existing AAC padding allowance, and verifies output timeline bounds. Both tracks survive,
including the longer 0.75-second secondary track; the gap output no longer retains its
half-second discontinuity. Ciphertext spools are disposed after inspection.

These tests and the existing preparation/staging tests pass locally. Context v32 predates
this correction. Conditional packet copying, exact encoder delay/padding, encoder quality
selection, fallback behavior and broader timestamp alignment still need implementation or
verification. This correction does not claim complete Desktop conversion parity.

### Conditional AAC packet copying

Timeline inspection now also returns bounded stream codec/type and first-timestamp metadata.
Preparation chooses copying per AAC track when its first timestamp is at or after the
nonnegative global start, following the pinned conversion predicate for unchanged codec,
channel and sample-rate settings. Other tracks still re-encode. Copied secondary tracks
receive an additional bounded decoding validation pass so copying does not bypass corruption
checks; the first track already receives the initial decoding pass.

Packet-hash regressions prove every compressed AAC packet is unchanged for the fragmented
and positive-offset fixtures. An updated actual-renderer comparison now gives the same
output timeline for both: `0.2713333333333333` seconds. The gap output is now
`0.2713333333333333` and the two-track output `0.7713333333333333`, retaining both tracks.
Re-encoded output still differs from the renderer because of encoder/container padding and
quality choices. Full tests for mixed copy/transcode tracks and broader start-time alignment
remain to be added. Local preparation, staging, timeline and TypeScript checks pass; these
changes are newer than Linux context v32.

### Mixed-track verification

`tests/entry.audio-mixed-tracks.ts` builds synthetic MP4 inputs containing AAC and FLAC in
both track orders. Preparation preserves both output tracks as AAC, copies the existing AAC
packet hashes unchanged, and fully decodes the re-encoded 0.75-second FLAC track to check
its sample count. Source duration metadata remains 0.75 seconds. With AAC second, the test
confirms the additional validation read and injects a failure into that read: encoding and
handoff never start, the source is disposed, and no ciphertext spool remains. This test
passes locally and is included in future Linux staging contexts. It verifies mixed codec
selection and validation-read failure handling; broader timestamp alignment and malformed
AAC payload coverage remain separate work.

### AAC quality and Linux validation

Pinned Mediabunny conversion defaults to `QUALITY_HIGH`. Executing its
`QUALITY_HIGH._toAudioBitrate('aac')` returns 192000: `encode.ts` multiplies the AAC base
128000 by quality factor 2 and selects the nearest supported rate, capped at 192000.
Preparation now requests 192000 bit/s for each re-encoded AAC track. The renderer probe
asserts and records this policy value. This aligns the requested bitrate, not encoder output
bytes or delay/padding across different codec implementations.

Context v33 (`42e30c9d0cd7566b00129253b216cf70fa5937bb8c24b958e5b8cefe68f6f810`)
contains the all-track conversion, gap normalization, conditional packet copying, secondary
validation and new bitrate. Both builds completed and all nine embedded audio tests passed
on each architecture, including the mixed AAC/FLAC cases and packet hash preservation.

| Architecture | Image tag | Image SHA-256 |
| --- | --- | --- |
| ARM64 | `threema-beeper-service:audio-copy-arm64` | `5f17b6985686a2bdc2fbe43c98a82f8003ed0b41d3e8da8af052c7f27324b8e6` |
| AMD64 | `threema-beeper-service:audio-copy-amd64` | `5b42dfd45cc42296f4663fc2d27e963569aec7f7d017ab95a5a9b0c3cd4d3418` |

Logs are `.local/linux-audio-copy-{arm64,amd64}-{build,test}.log`; all processes completed.
The tests used embedded fixtures without host test mounts, networking, accounts or messages.
Container restrictions and native/emulated address-space limits match v32. Local preparation,
mixed-track, staging and TypeScript checks pass. Production audio remains disabled pending
remaining container/playback, timestamp and fallback work.

## Opus fallback foundation

`docs/OPUS-PINS.json` pins libopus 1.6.1 from the official Xiph download. Its archive hash
matches the value published at
https://opus-codec.org/release/stable/2026/01/14/libopus-1_6_1.html. Detached-signature
verification remains pending. Source preparation and Linux staging verify the archive hash;
`native/build-opus.sh` builds a static library and retains COPYING, AUTHORS, pin and build
configuration. FFmpeg enables its `libopus` encoder; runtime images include those notices.

`prepareOpusAttachment` shares bounded source validation, timeline inspection, conditional
packet copying, encrypted output spooling and cleanup with AAC preparation. It targets
Opus-in-MP4 at 128000 bit/s (the pinned high-quality Opus target). Its eventual outbound
message kind must be generic file, as in Desktop's fallback; audio staging does not yet call
it. Tests locally verify the Opus stream, full decode, preserved source duration, output
limits and disposal. Existing AAC tests and TypeScript also pass.

Initial Linux context v34 is
`97577ddf402ee538cd7668a6b342224cd558182f473300e0b951c81039fe1834`.
Its ARM64 build successfully compiled libopus but failed FFmpeg's package/link check.
The corrected build passes `--pkg-config-flags=--static` so private static dependencies
are included. Context v35 is
`2b439f02a608a15a8d1c0380b9499aefb9230f0a08dc5f38a41b7740b5860b26`
and also contains the Opus preparation helper and regression. The v34 AMD64 build also
terminated at the same FFmpeg package/link check. Corrected v35 ARM64 and AMD64 builds
are running; Linux verification is pending. Logs are
`.local/linux-opus-v35-{arm64,amd64}-build.log`.

The corrected v35 ARM64 build completed as image
`f91c07fd6c6e6855d262d16303d5262b4db548cbf5206ef3e807c8c80a0e093e`
(`threema-beeper-service:opus-arm64`). Six embedded AAC/Opus preparation, mixed-track and
staging tests passed using the native limiter with 512 MiB codec address space in the same
offline/read-only 768 MiB container restrictions as earlier runs. The test log is
`.local/linux-opus-v35-arm64-test.log`. Corrected AMD64 is still compiling FFmpeg.

### Ordered preparation fallback

`src/media/audio-fallback.ts` now attempts AAC, then Opus, then transfers the original
authenticated attachment to its caller. Codec attempts borrow the source and own only their
generated spools. The source is disposed after successful conversion; original-file fallback
transfers its disposal responsibility. Original bytes must still fit the output limit.
Cancellation and `AudioPreparationCleanupError` stop fallback. Source cleanup failure after
conversion rejects handoff and disposes the encoded output, rather than trying another codec.

The local regression uses real codecs behind a synthetic failure wrapper to exercise all
three outcomes, original-byte preservation, ownership/disposal, cancellation, size limits
and cleanup retry. It passes. The helper and test are newer than context v35. Staging,
durable projection, dispatch and echo reconciliation still need to admit fallback file
results without labeling them native audio. The production launcher remains unchanged.

### Durable fallback file dispatch

Outbox schema 12 expands the immutable audio-source projection to distinguish native
`audio` output from fallback `file` output. File projections cannot carry a native audio
duration. The doctor accepts schema 12, and migration coverage verifies that existing schema
11 native-audio metadata and settled state survive reopening. Schema 10 migration coverage
continues to pass as well.

Audio staging now calls the ordered fallback helper. AAC commands carry native duration;
Opus and original-file commands omit it. Opus gets a generated `.m4a` name; original-file
fallback retains the verified original MIME, filename and byte count. The projection is
persisted before ID allocation. Echo reconciliation requires the stored message kind and
canonical filename/MIME/size/caption, preventing a fallback file from being mistaken for
native audio.

New durable tests cover Opus/file and original/file metadata, rejection of an injected native
duration before sending, restart after uncertain ID allocation, no automatic resend,
wrong-kind echo rejection, correct echo settlement and idempotent original-event binding.
The authenticated staging test also verifies original-byte preservation and file metadata
when both codec attempts fail. Ten focused outbox/staging/doctor/backup/dispatcher tests
passed, followed by the expanded staging and schema-11 migration checks. TypeScript passes.
These changes are newer than v35; that AMD64 build is still compiling the earlier codec
foundation. Opus fallback staging needs its own authenticated end-to-end failure fixture,
and fallback projections need explicit backup coverage. Production audio remains disabled.

### Authenticated fallback and backup verification

The staging regression now forces only AAC encoding to fail while leaving the real Opus
encoder available. It verifies a single authenticated download across both attempts,
inspects the staged bytes as Opus, checks generic-file command/projection metadata without
native audio duration, and confirms token/spool cleanup. The local test passes.

The encrypted backup drill now includes uncertain native audio, Opus/file fallback and
original/file fallback in separate chats. After restore and adoption, each projection and
allocated ID survives, none is eligible for automatic sending, and matching echoes settle
the corresponding original Matrix event. The fixture uses separate chats because the
existing ordering guard correctly prevents claiming another request behind an unsettled
send in the same chat. The expanded drill passes locally.

The corrected v35 AMD64 build completed as
`15e4d3784565a749b136ca5c8c3810c9d06ceb2724430f3826ad97d038f213af`
(`threema-beeper-service:opus-amd64`). All six embedded AAC/Opus preparation, mixed-track
and staging tests passed under the earlier offline/read-only container restrictions, using
4 GiB codec address space for emulation and 768 MiB container memory. Log:
`.local/linux-opus-v35-amd64-test.log`. All v35 build/test processes are now complete.
These images predate schema 12 and fallback dispatch/staging integration, which still need
a fresh Linux context. Native AMD64 lower-address-space validation remains open.

### Integrated Linux fallback validation

Context v36 (`cb2c7f33e06ef95da4d36ad510ba304cc74d2049c81cac1004675e54cc0c6164`)
contains schema 12, ordered fallback, authenticated AAC/Opus/original staging and durable
file-kind dispatch/echo handling. Both service images built successfully:

| Architecture | Image tag | Image SHA-256 |
| --- | --- | --- |
| ARM64 | `threema-beeper-service:audio-fallback-arm64` | `1bf1ed30570b667ed7a0f36f45073ff09c085baf810bd79f45693939838809c1` |
| AMD64 | `threema-beeper-service:audio-fallback-amd64` | `80d4d455a987578f96d1c02a2e2241134128409efc66ac9dc91ede1bc984362e` |

All 13 embedded audio tests passed on each architecture: source timeline/decoding, packet
copying, mixed tracks, AAC/Opus preparation, ordered fallback, authenticated staging and
native-audio/fallback-file uncertain restart and echoes. Tests used no host source/test
mounts or account access. Logs: `.local/linux-audio-fallback-{arm64,amd64}-{build,test}.log`.
All four build/test processes completed. TypeScript also passes.

Containers retained the existing network-disabled, read-only, capability-free configuration,
768 MiB memory cap and 64 MiB tmpfs. Real codec processes used 512 MiB address space on ARM64
and 4 GiB on emulated AMD64; synthetic failure wrappers exercise separate failure paths.
The encrypted backup drill was verified locally and is not part of these 13 embedded tests.
This validates the implemented synthetic fallback route, not complete Desktop playback,
container/padding parity or live account compatibility. Production audio remains disabled.

## Silent renderer loading and decoding

`pnpm run probe:audio-playback` prepares AAC and Opus versions of each of the seven source
fixtures, then loads all 14 generated MP4 files in the pinned secure renderer. It never
calls playback: an OfflineAudioContext decodes samples, and muted media elements only load
metadata. All 14 files decoded to non-silent samples and exposed finite positive media
durations below the fixture limit. The harness asserts Electron 40.10.0 / Chromium
144.0.7559.236, blocks HTTP/WS and uses a discarded temporary profile.

The two-track outputs expose a longer media-element duration while Web Audio decodes the
first track; this is observed consumer behavior, not loss of the second stored track.
`.local/audio-playback-report.json` records the sample/element observations and generated
file hashes. The script also records the producer codec version on subsequent runs.
This initial run used the installed Homebrew FFmpeg 9.0.1, whereas Linux images pin FFmpeg
8.0.3. Therefore it does not yet prove renderer loading of Linux-produced bytes. That
cross-environment check, mobile playback, encoder/container padding and broader alignment
cases remain open. TypeScript passes.

### Linux-produced files in the pinned renderer

The playback probe now supports `--generate-only` and `--fixtures <input.json> <report.json>`.
Both v36 service images generated 14 fixtures using their embedded bridge code, FFmpeg 8.0.3
and native limiter. Only the probe script was mounted read-only; production source and codecs
came from the images. Generation used the established offline/read-only restrictions and
native ARM64 versus emulated AMD64 address-space limits.

Each exact output set was then loaded in Electron 40.10.0 / Chromium 144.0.7559.236 on macOS.
All 28 checks passed: finite positive media-element duration, successful silent Web Audio
decoding, and non-silent samples. Hashes are verified before renderer loading. Producer
platform, architecture and codec version accompany the per-file hashes and observations.
Artifacts are `.local/audio-playback-linux-{arm64,amd64}-{fixtures,report}.json` and
`.local/audio-playback-linux-{arm64,amd64}-renderer.log`. All generation/renderer processes
completed; TypeScript passes.

This closes the local-versus-Linux producer gap for these fixtures. It does not prove mobile
playback, sample-exact Desktop encoder parity, arbitrary container/edit-list behavior or live
account delivery. No audio was played and no accounts were used.
