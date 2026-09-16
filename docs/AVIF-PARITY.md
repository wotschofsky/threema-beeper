# AVIF preparation contract

Status: source-verified output policy; pixel/color parity and production admission incomplete.

Desktop pin: `63f65806398400017201ef2aaa4f97dfc122e5b0`, Electron `40.10.0`.
The [Electron release record](https://releases.electronjs.org/release/v40.10.0) identifies
Chromium `144.0.7559.236`.

In pinned Desktop `src/app/ui/modal/media-message/index.ts`, `resizeImage` sends AVIF
through `downsizeImage` requesting its original MIME. That function uses an alpha-enabled
OffscreenCanvas and calls `convertToBlob`. Chromium's
[matching MIME selector](https://raw.githubusercontent.com/chromium/chromium/144.0.7559.236/third_party/blink/renderer/platform/image-encoders/image_encoder_utils.cc)
defaults to PNG and recognizes only PNG, JPEG and WebP for encoding. Its
[canvas blob creator](https://raw.githubusercontent.com/chromium/chromium/144.0.7559.236/third_party/blink/renderer/core/html/canvas/canvas_async_blob_creator.cc)
uses that selector and sets the resulting Blob MIME from the selected encoding.
Thus the source-derived AVIF main output contract is PNG, with first-frame pixels,
alpha and max-side 2000. This is source evidence, not a renderer execution test.

Desktop `MediaMessage.svelte` prepares the thumbnail from the original file before
main-image resizing, and passes both Blob MIME types independently to the send controller.
`getThumbnailMediaType(AVIF)` selects JPEG. Therefore the expected pair is PNG main plus
JPEG thumbnail. Thumbnail resizing starts with original pixels, max-side 512 and quality
0.8; it does not downscale the already resized main image. Desktop also keeps the original
filename even if encoded MIME changes. These details require deliberate parity work in the
bridge, whose existing projection/worker validation derives thumbnail MIME from main MIME
and whose current bundles generate thumbnails from canonical main images.

The bridge AVIF adapter now fixes main output to PNG. It remains disabled pending color
management/HDR, explicit thumbnail MIME persistence and validation, JPEG alpha/quality parity, filename policy, codec source packaging and renderer comparison. Do not enable
AVIF merely by adding its input MIME to admission.

Local native tests include a lossless cropped alpha grid and a two-frame animation whose
first frame is translucent red and second is opaque green. The animation assertion compares
every emitted RGBA byte and confirms that only the first frame is output. Tests use libavif
1.4.2 locally; Linux resource-limited AVIF execution remains unverified.

Downloaded matching Chromium source hashes (SHA-256):

- `chromium-image-encoder.cc`: `3e3e0f7f7b61c762e8661377d04810114a9aca9358a49d52b7474a308eb713db`
- `chromium-image-encoder.h`: `4375742d4b721b52acdad81cc403a0f830c0b1f366c1fd97162c34d405e7c6fa`
- `chromium-image-encoder-utils.cc`: `aa81718637eedee4ef0c76416c5ebad9a776bf82599148786e1f8e1fb3fa9c07`
- `chromium-canvas-blob.cc`: `e2a511dc9a206c6afe3d030762cc3b05084f709825e40cfd0da3c61486b6f5af`

`prepareAvifBundle` now implements the independent-source bundle path: it owns a verified
repeatable encrypted source, creates the PNG main and JPEG thumbnail via separate decoder
passes, then disposes the source before handing out either output. A source cleanup failure
rejects handoff and cleans the generated outputs. Thumbnail failure likewise cleans both
main and source. Its test reduces the main to 1x1 while retaining the original 2x4 thumbnail,
checks two source reads, independent output MIME types and the two surviving encrypted spools,
and exercises thumbnail exhaustion and source-cleanup retry. Root typecheck passes.

This establishes format selection and ownership only. JPEG alpha compositing and encoder
quality still need comparison against Chromium, and the mixed-MIME bundle is not yet accepted
by staging, immutable projections or the Desktop send proxy. AVIF ingress remains disabled.

Schema-10 follow-up: immutable projections now store thumbnail MIME explicitly, normalize
legacy schema-9 rows with the old mapping, and allow independent thumbnail dimensions up
to 512. Echo checks use that stored MIME and dispatch checks it against the prepared command.
Legacy and mixed PNG/JPEG restart cases, doctor and native backup/restore pass. The remaining
mixed-MIME restriction is in prepared-command/staging and Desktop proxy validation; projection
persistence is now implemented. Production AVIF remains disabled.

Worker/controller follow-up: prepared-image IPC, worker staging, the headless worker command
and both Desktop controller entry points now validate PNG/JPEG thumbnail MIME independently
of the main MIME, with separate 512-pixel dimension bounds. The patch manifest and copied
overlay match the rebuilt headless bundle. Seventeen focused cases pass, including the real
Desktop proxy sending a 1x1 PNG with an 8x4 JPEG thumbnail through the allocated-ID barrier.
Both typechecks, overlay/patch verification and the 788-module bundle build pass. This closes
the earlier mixed-MIME staging/proxy restriction; codec packaging, rendering/color parity and
connecting AVIF preparation to ingress remain unfinished.

JPEG alpha follow-up: a pixel regression reproduced alpha being dropped (fully transparent
red encoded near full red). `prepareStaticImage` now composites JPEG output on black in
planar RGB before removing alpha, matching the pinned Chromium encoder's `kBlendOnBlack`
policy. The regression checks alpha 0, 63, 128 and 255 against decoded JPEG pixels (tolerance
4 for lossy encoding), and separately verifies exact unchanged RGBA output for PNG. Five
local codec/AVIF-bundle/preparation cases pass. This fixes compositing for JPEG thumbnails
across AVIF/GIF/WebP paths; interpolation at alpha edges, color management/HDR and JPEG
quality parity remain separate work.

The final compositing order is before resizing: a transparent-red/opaque-blue edge fixture
reproduced hidden-color bleed when flattening happened afterward. The regression compares
its resized JPEG to an explicitly black-composited opaque equivalent; they must be identical.
An initial assumption that the default scaler averages a 4x4 image to its arithmetic mean
was disproved, so the test uses this compositing invariant rather than asserting an unverified
resampling algorithm. Exact Chromium resampling parity is still pending.

The final codec regression also passes on source-built Linux ARM64 FFmpeg 8.0.3 with the
normal 512 MiB per-codec address-space limit, 768 MiB container cap, networking disabled and
read-only root. This validation mounts the changed media sources and test read-only into the
existing `webp-arm64` image; it is not evidence that a newly packaged image contains the fix.
Root typecheck and five local codec/preparation cases pass.

Linux packaging now pins official libavif 1.4.2 and dav1d 1.5.4 source archives in
`AVIF-PINS.json` and `DAV1D-PINS.json`. `prepare:codec` checks all four codec archives and
staging rechecks the AVIF hashes before including them in the context integrity manifest.
`native/build-avif.sh` builds dav1d statically with tests/tools disabled, then libavif with
only that decoder and no libyuv/sharpyuv dependency. Meson wrap downloads and CMake FetchContent
are disabled. The runtime receives the linked helper, both copyright notices and build
configuration/pins; no source archives or startup downloads are needed. These new pins have
HTTPS/hash verification only; independent signatures and complete release provenance remain
pending.

The first ARM64 service build is running from context
`b881d57680b72553417115725306dab4ee185f8d8202e9cdb84b188257fab4a5` (v20), tag
`threema-beeper-service:avif-arm64`, log `.local/linux-avif-arm64-build.log`.
Compilation and embedded Linux AVIF execution remain unverified until that build/test finishes.
This context also includes schema 10, mixed-thumbnail validation and JPEG alpha compositing.

The ARM64 v20 image completed as
`sha256:65dec3dda8a7f7d431da58ab859fd1a097c56bc7690743e116312d1f18d34bb0`.
All eight embedded AVIF helper/pipeline, image-codec and image-preparation cases pass without
host mounts, with networking disabled, read-only root, dropped capabilities, no-new-privileges
and a 768 MiB container cap. The AVIF process/bundle tests use the real limiter with the normal
512 MiB codec address-space cap. Thus actual source-built libavif/dav1d Linux execution is now
verified for these fixtures; it does not establish color/HDR or live account parity.
The matching AMD64 build is running from v20, tag `threema-beeper-service:avif-amd64`, log
`.local/linux-avif-amd64-build.log`; AMD64 execution is still pending.

AMD64 v20 packaging completed as
`sha256:0350b569d5e90930c9c35fde564178104b06eb97fc09bb2929a1f807db794558`.
Its eight embedded helper/pipeline/codec/preparation cases pass under AMD64 emulation without
host mounts, with network disabled, read-only root, dropped capabilities and a 768 MiB
container cap. The test-only address-space allowance is 4 GiB for emulation; native AMD64
execution with normal 512 MiB codec limits remains pending.

`createImagePreparation` now routes verified AVIF downloads through `prepareAvifBundle`,
persists explicit PNG/JPEG output metadata and stages both streams through opaque worker
tokens. It preserves the original filename for AVIF as pinned Desktop does. The end-to-end
synthetic preparation test checks output signatures/dimensions, MIME metadata, original
filename and complete bridge spool cleanup; corrupt encrypted input is rejected before any
additional worker preparation. All four format cases and root typecheck pass. The four cases
also pass on Linux ARM64 with normal hard limits using read-only mounts of the changed source
and test. V20 images predate this latest integration and must be rebuilt before distribution.
AVIF is still rejected by ingress, and service startup still does not enable image admission;
rendering/color parity remains outstanding.

## Executed renderer comparison and clean-aperture correction

`pnpm run probe:image-renderer` now executes the actual pinned Desktop `downsizeImage` function
(extracted with TypeScript's AST and transpiled without changing its body) in Electron 40.10.0 /
Chromium 144.0.7559.236. The small assertion/type predicates are supplied by the harness.
The runtime was installed from the pinned Electron npm package and verified by its bundled
archive checksums. The probe uses a fresh temporary profile, a hidden sandboxed renderer,
no Node integration, denied permissions and blocked HTTP/WebSocket requests. It loads only
synthetic AVIF fixtures and deletes the temporary profile after the process exits. macOS
required launching the renderer outside the shell sandbox. No Desktop application or account
was launched.

Three executed fixtures establish PNG main/JPEG thumbnail outputs and first-frame handling.
The raw reference output and source hash are committed in `tests/fixtures/renderer-avif.json`;
the latest run also writes `.local/renderer-image-report.json`. The real renderer contradicted
the earlier clean-aperture assumption: it ignores the fixture's clap crop and emits the full
rotated canvas (4x8), while the earlier native helper cropped it to 2x4. The helper now preserves
the full decoded canvas before rotation/mirroring, matching pinned Desktop. Earlier crop-based
results in this document describe the superseded implementation.

All eight local helper/bundle/preparation cases pass after the correction. Four native helper
cases also pass with ASan/UBSan, including comparison to the committed renderer references.
The animation matches exactly. On the translucent grid dimensions/alpha agree exactly and RGB
channels differ by at most two levels; the regression permits that measured fixture tolerance.
That observation does not prove general color equivalence. One-pixel resizing, ICC/wide-gamut,
HDR, JPEG quality and broader rendering comparisons remain pending. Both v20 Linux images
predate this correction and must be rebuilt/retested before claiming current Linux parity.
Root typecheck passes.

## Embedded ICC conversion

A synthetic profile fixture (D65 white, P3 primaries, gamma 2.2, generated with Little CMS)
exposed up to 60 RGB levels of error when the native helper ignored the ICC profile. The
helper now uses Little CMS 2.19 to convert embedded RGB ICC profiles to sRGB, preserving
straight alpha and transforming scanlines in place. Profiles above 4 MiB, malformed profiles
and non-RGB profiles are rejected before pixel output. Codec process memory/CPU/output limits
still apply. ICC bytes and profile descriptions are not emitted.

The executable Electron probe now has four fixtures. Its wide-gamut reference is committed;
the transformed native pixels differ by at most five RGB levels with exact alpha on this
fixture (previously 60). Disabling the transform optimizer did not eliminate the residual
difference. The five-level regression tolerance records the measured fixture result, not
full color parity. CICP-only primaries/transfers, HDR, higher precision and the remaining
Chromium differences still need implementation/comparison. Six helper/bundle cases pass
with ASan/UBSan on the helper; linked system libraries are not instrumented. Root typecheck
passes. Local helper compilation now requires `pkg-config --cflags --libs libavif lcms2`.

`LCMS-PINS.json` pins the official Little CMS 2.19 tag archive by SHA-256. Source preparation
and staging verify it alongside the other codec archives. Linux builds the static core with
tools/tests and optional plugins disabled, links it into the helper, and retains its license,
pin and CMake configuration. Independent source-signature verification remains pending.
Both architecture builds were started from context
`17931b5c8f2597d403eb8f0b2242cdc2b072097b6f927055a5f39a75a4ded8fc` (v21), tags
`threema-beeper-service:icc-{arm64,amd64}`, logs `.local/linux-icc-{arm64,amd64}-build.log`.
This context contains the crop correction, latest AVIF preparation and ICC conversion;
Linux execution is pending build/test completion.

The ARM64 v21 image completed as
`sha256:340416a198542674487b40758c6f31dc8625af45d1b41cd9c3c01e653c5001df`.
All eleven embedded helper/reference/ICC/bundle/codec/preparation cases pass without host
mounts, with network disabled, read-only root, dropped capabilities, no-new-privileges and
768 MiB container memory. Process/bundle preparation uses the real 512 MiB address-space
limiter. This verifies current crop correction, ICC linkage and encrypted AVIF preparation
on Linux ARM64. AMD64 v21 remains compiling; no native AMD64 acceptance is claimed.

## CICP primaries and transfer conversion

The helper now constructs an RGB input profile from declared CICP primaries when no ICC
profile exists, then converts to sRGB. Embedded ICC still takes precedence. Supported curves
include sRGB, simple gamma/linear curves exposed by libavif, and BT.601/BT.2020/SMPTE240
inverse transfer formulas from pinned `src/colr.c`. Unknown primaries and unimplemented
transfer functions (including PQ/HLG HDR for now) fail before pixel output; implementing HDR
remains required, not out of scope. Unspecified primaries/transfer retain the sRGB fallback.

The executed Electron probe now has seven synthetic fixtures, adding P3/sRGB transfer, linear
BT.709 primaries, and BT.709 transfer without ICC. P3 and linear reference errors fell from
60/76 RGB levels to at most four, with exact alpha. The standard BT.709 inverse transfer
produced up to 16 levels of error against the renderer, whose fixture output remains close
to the original sRGB values. The helper therefore treats BT.709 transfer as sRGB to match
this pinned renderer observation. This behavior is supported by the executed fixture;
broader BT.709/color combinations and the other implemented SDR curves still need reference
coverage. The failed attempt to retrieve the old Blink AVIF source path is not evidence.

Ten local helper/bundle/preparation cases pass after CICP integration. Six helper cases pass
with ASan/UBSan, including the renderer references and explicit rejection of unimplemented
HDR/unknown transfer identifiers. Root typecheck passes. The remaining measured RGB
mismatches, high-bit-depth precision, HDR and resizing/quality parity are unfinished.
V21 Linux images predate this CICP change and require rebuilding/retesting.

The AMD64 v21 ICC image completed as
`sha256:9c4fd8eaa574c4ca1854909696bcd45cc4dad1b1ff3accc29d6c1d4fd1b466c2`.
All eleven embedded cases pass under emulation without host mounts, network disabled,
read-only root and a 768 MiB container cap. The test-only address-space cap is 4 GiB;
native AMD64 testing at 512 MiB remains pending. No builds are left running from this step.

## Executed high-bit-depth behavior

Two new synthetic dark-gradient fixtures use 10-bit and 12-bit AVIF with linear transfer.
Their 16-bit PNG source stores red levels derived from [1,2,3,4,8,16,32,64]/1023, with opaque
alpha; avifenc quantizes that source to the requested AVIF depth with lossless codec settings.
The executable pinned Electron probe now covers nine fixtures. Both high-bit-depth fixture
outputs match the current helper exactly, including its eight-bit-before-color-conversion
quantization. For example, the first two source levels become zero and later levels form
[13,13,22,34,50,71] in the red channel. A planned precision increase was not implemented,
because it would contradict these observed Desktop outputs. This is evidence for these SDR
fixtures only, not HDR or every high-bit-depth profile.

The exact reference pixels are committed and checked by the native regression with zero
channel tolerance for these two fixtures. Six helper test cases and root typecheck pass.
Other color mismatches, HDR and resizing/quality parity remain incomplete.

The v22 Linux context is
`c1a388f7d8e704dcc16cf2706303e02d1973e9ac4b63ef7257d619337ecfd634`, containing current
CICP conversion and the nine executed renderer reference fixtures. ARM64 completed as
`sha256:14f9ebcc8e4c2220d7f73832f801175010ff4dd687082148d3b2d6cf2ca5096b`, tag
`threema-beeper-service:cicp-arm64`. Its twelve embedded helper/codec/preparation cases pass
without host mounts, with network disabled, read-only root, dropped capabilities and 768 MiB
container memory; process preparation uses normal 512 MiB codec address-space limits.
The matching AMD64 build remains running, tag `threema-beeper-service:cicp-amd64`, log
`.local/linux-cicp-amd64-build.log`; ARM64 log is `.local/linux-cicp-arm64-build.log`.

## PQ/HLG SDR tone mapping

The executable Electron probe now contains twelve synthetic fixtures, including 10-bit
BT.2020 PQ and HLG grayscale/primary-color grids and a PQ grid with 4000-nit CLLI metadata.
The helper now accepts PQ/HLG without ICC and maps them to SDR. It applies the inverse
transfer in linear light, converts to linear BT.2020, applies HLG's luminance-dependent OOTF
where appropriate, then max-RGB Reinhard gain and sRGB conversion. Scanline float buffers
remain bounded; no full extra floating-point image or plaintext file is created.

The algorithm follows the exact pinned Chromium
[tone-map implementation](https://raw.githubusercontent.com/chromium/chromium/144.0.7559.236/cc/paint/tone_map_util.cc).
The executed canvas path uses the default 203-nit white and 1000-nit content maximum. Applying
the source's 4000-nit CLLI value initially differed by 18 RGB levels; the renderer fixture
shows that metadata is not carried through this Desktop bitmap/canvas path. The helper now
uses the observed default for that case too. Both PQ references match exactly, and HLG
matches within one RGB level across the committed opaque grayscale and primary-color grid.
This does not prove arbitrary HDR color/alpha/resizing or gain-map equivalence.

Eleven local helper/bundle/preparation cases pass. Six helper cases also pass with ASan/UBSan,
including all twelve renderer references and rejection of unknown transfer identifiers.
Root typecheck passes. Existing v22 Linux images predate HDR conversion; rebuild/execution
is still required. HDR alpha, gain maps/AGTM, other metadata and remaining JPEG/resizing/color
mismatches remain required parity work. Earlier notes stating PQ/HLG are rejected describe
the superseded helper.

The AMD64 v22 image completed as
`sha256:1ad6f09a52d7e2eccf7128f0af7d4b8778682019855cc825b776e3f9f723dc99`.
Its twelve embedded cases pass without host mounts under emulation, with networking disabled,
read-only root and a 768 MiB container cap. It uses the test-only 4 GiB address-space allowance;
native AMD64 acceptance at 512 MiB remains pending. No build processes remain running.

Pinned Chromium tone-map source SHA-256: `3dffeadc892f81e50620e6b2e80435b113a53afd31e440a2ad19c5c8d62897e3`.

## HDR alpha comparison

Two more executed fixtures combine PQ/HLG highlights with alpha rows 0, 63, 128 and 255.
The helper initially retained hidden RGB under alpha zero while Desktop wrote zero. HDR
output now clears fully transparent pixels after conversion. Alpha matches exactly throughout;
fully transparent and opaque rows match exactly in these fixtures. At alpha 128 RGB differs
by at most one level, and at alpha 63 by at most four for PQ / three for HLG. The committed
reference regression uses those measured per-row bounds, without relaxing opaque checks.
The renderer probe now covers fourteen fixtures. Eleven local integration cases and six
ASan/UBSan helper cases pass, as does root typecheck.

The v23 context
`189156f677e6859b01fa945ad0aff4c22796f8b79d27cc16dff91698d2effea1` now packages the HDR
implementation and alpha fix. Both architecture builds started as
`threema-beeper-service:hdr-{arm64,amd64}`, logs `.local/linux-hdr-{arm64,amd64}-build.log`.
Linux execution is pending build completion. Gain-map/AGTM support, broader HDR metadata,
resampling, JPEG quality and remaining measured color differences still require work before
production image admission.

ARM64 v23 completed as
`sha256:1c8a0a6e06452fc432900a9911364d32ba90055c73a1946e352dbbfdd9ea030d`.
All twelve embedded helper/codec/preparation cases (including fourteen renderer-reference
fixtures) pass without host mounts, with network disabled, read-only root, dropped
capabilities, no-new-privileges and a 768 MiB container cap. Preparation processes use the
normal 512 MiB address-space limit. This verifies the current
HDR implementation on ARM64 for these cases, not the outstanding full image contract.

AMD64 v23 completed as
`sha256:40b5d163f0e17b52c82c2708b8f0f66a9c5fdeb36d9c032c2ce73f8d2ef586c1`.
All twelve embedded cases also pass under AMD64 emulation, with the same container
restrictions and `MEDIA_TEST_ADDRESS_SPACE_BYTES=4294967296` for Rosetta. This does not
establish native AMD64 operation under the production 512 MiB address-space bound.
