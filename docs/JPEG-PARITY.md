# JPEG encoder work in progress

The pinned Chromium encoder rounds canvas quality to an integer percentage and blends
alpha on black. At quality 100 it explicitly selects 4:4:4. Desktop requests quality 85
for main images and 80 for thumbnails. The current bridge FFmpeg MJPEG quality-scale 3
and 4:4:4 setting does not establish equivalence with that contract.

Reference: [Chromium 144.0.7559.236 image encoder](https://raw.githubusercontent.com/chromium/chromium/144.0.7559.236/third_party/blink/renderer/platform/image-encoders/image_encoder.cc).

`native/jpeg-encode.c` is an experimental libjpeg helper, included in the Linux build
and image preparation pipeline. Production image admission remains disabled. It reads exactly one RGB/RGBA PAM frame from stdin,
accepts quality 0–100 and a pixel limit, writes baseline JPEG to stdout, and rejects
trailing input. Dimensions are limited to 8192, the header to six bounded lines after
the magic, and pixel scratch storage to one row. It uses black alpha blending, 4:2:0
except 4:4:4 at quality 100, and optimized Huffman tables. Nine executed pinned-renderer
fixtures now match the helper's complete JPEG output byte for byte (details below).
Truncation or trailing-data errors can occur after provisional output; callers must
discard all output unless the process completes successfully. Service use must retain
the existing external CPU, memory, output-byte and wall-time limits.

Local development uses Homebrew libjpeg-turbo 3.2.0. Build and run synthetic tests with:

```sh
cc -O2 -Wall -Wextra -Werror native/jpeg-encode.c -o .local/jpeg-encode $(pkg-config --cflags --libs libjpeg)
pnpm run test:jpeg-encode
```

Tests check baseline dimensions, sampling, distinct quality quantization tables,
black-composited RGB/RGBA byte equivalence, absent EXIF, canonical ICC, complete JPEG termination,
and rejection of malformed headers, overflow, oversized images and incomplete/extra pixels.
Remaining work includes integrated Linux execution and broader resize/color parity.

`pnpm run probe:jpeg-renderer` executes nine synthetic 17×13 fixtures in Electron 40.10.0
(Chromium 144.0.7559.236), with a temporary profile and network blocked. Opaque gradients,
alpha values 0/63/128/255, and hidden-color edges are encoded at qualities 80, 85 and 100.
The initial native output had identical quantization, sampling, Huffman tables and scan
data; the sole difference was a 474-byte renderer ICC marker. The helper now emits the
same generated 456-byte sRGB profile, preserved in `native/jpeg-srgb-profile.h`, including
its embedded copyright tag. Source image profiles and metadata are never copied through.
The resulting complete bytes match all nine renderer outputs.

`tests/fixtures/renderer-jpeg.json` retains runtime versions, synthetic input RGBA and
renderer JPEG bytes as base64. The helper regression test compares complete JPEG bytes,
including this profile; it does not regenerate expected results from the helper. The
probe's fresh report is `.local/renderer-jpeg-report.json`. These fixtures isolate JPEG
encoding via canvas pixel insertion without resizing; they do not verify the complete
Desktop decode/resize pipeline or other codec versions. Linux execution is recorded below.

## Linux packaging

`docs/JPEG-PINS.json` pins the official libjpeg-turbo 3.2.0 release tarball by SHA-256.
Preparation and staging both verify the archive; Docker verifies the complete staged
context before building. `native/build-jpeg.sh` builds a static libjpeg with SIMD required,
without tools, TurboJPEG or arithmetic coding. Runtime contains `/usr/local/bin/jpeg-encode`
and `/usr/share/libjpeg-turbo/{LICENSE.md,README.ijg,JPEG-PINS.json,CMakeCache.txt}`.
The official release signature remains unverified and Debian build dependencies remain
unpinned; this is not complete release provenance or a reproducible-toolchain claim.

Context v24 is `a4ea90f2beb1b87e9a289c99ff025a2fc955983f7a0704c0344388eddc021117`.
ARM64 and AMD64 service builds completed as `threema-beeper-service:jpeg-{arm64,amd64}`,
with logs `.local/linux-jpeg-{arm64,amd64}-build.log`:

- ARM64: `sha256:c2392c7564eba7fe741164eefb9ffb853ef7ed7c75ff05d92b518e29ab256ac1`
- AMD64: `sha256:795cdbf7ba6a38f66ada5ab5af44139fa1fdebcab73b5722b01afb01ba215f33`

Each image passes three embedded JPEG helper cases (including all nine exact renderer
references) and the twelve existing AVIF/codec/image-preparation cases, without host mounts,
with network disabled, read-only root, dropped capabilities, no-new-privileges and a
768 MiB container cap. JPEG helper cases directly launch the helper with a three-second
timeout and a 64 KiB output bound. Existing pipeline cases additionally use media-limits:
512 MiB address space on ARM64 and 4 GiB under AMD64 Rosetta emulation. Native AMD64
acceptance at 512 MiB and the new encoder's pipeline integration remain unverified.

## Pipeline integration (v25)

`prepareStaticImage` now pipes FFmpeg RGB PAM output into the JPEG helper through a
64 KiB backpressure buffer. Both processes run through the existing limiter, share
cancellation, and must complete successfully before output is accepted. The intermediate
pixel stream has its own bound; final JPEG bytes retain the configured attachment bound.
No decoded pixels are written to disk. PNG encoding remains on its existing path.
JPEG defaults to quality 85; bundle thumbnail paths explicitly select quality 80.
Linux FFmpeg now includes the PAM encoder required by this pipe.

The full pipeline initially failed the renderer references: FFmpeg's 8-bit premultiply
filter altered even opaque RGB values. Float premultiplication fixed opaque fixtures but
still differed on partial alpha. Explicit per-channel `floor(channel*alpha/255+0.5)`
before resizing fixes all nine exact encoded-byte comparisons. This also retains the
existing hidden-color-edge regression. The test additionally checks quality tables on
encrypted main/thumbnail outputs and rejection for a missing encoder, output overflow,
and invalid quality. All six local image codec/AVIF/image-preparation cases and TypeScript
checks pass. This is encoding parity without resizing; broader sampling remains open.

Context v25 is `309d034dd0b58127ecf693daedc9fa6ac87c6417933b18c36863da3caf7bbd73`.
Builds are running as `threema-beeper-service:jpeg-pipeline-{arm64,amd64}`, with logs
`.local/linux-jpeg-pipeline-{arm64,amd64}-build.log`. The v24 execution evidence above
predates pipeline integration; do not use it to claim the new Linux path has passed.

ARM64 v25 completed as
`sha256:47fc51f8930f0e1a98181692c462ea994ea4a0921d3e35b491a18533faac6d10`.
All fifteen embedded media tests pass, including exact renderer comparisons through the
FFmpeg/PAM/JPEG pipeline, with network disabled, read-only root, no host mounts, dropped
capabilities, a 768 MiB container cap and normal 512 MiB codec address-space limits.
AMD64 v25 is still compiling; its runtime result is pending.

## Original-source thumbnails and filenames

The pinned Desktop `app/ui/modal/media-message/index.ts` passes the original `file` to
`generateThumbnail`/`downsizeImage` independently of the prepared main image. PNG/JPEG
bundles now read the verified source twice rather than deriving thumbnails from the
already downsized/recompressed main image. They own source cleanup and reject both outputs
if cleanup fails, retrying source cleanup while disposing provisional outputs. The local
regression checks a 1-pixel main with an 8×4 thumbnail byte-identical to independently
preparing the original, plus a cleanup failure after both source reads.

Image preparation now preserves the incoming filename for all supported image types,
as Desktop does, instead of replacing its extension. MIME remains explicit in prepared
metadata. All five affected local codec/preparation tests and TypeScript checks pass.
These changes postdate v25 and require a new Linux build for embedded execution.

Context v26: `412ca7af02dd91e23c420d22896fe15820e461467148bd677ceb215e35624387`.
ARM64 build started as `threema-beeper-service:original-thumbnail-arm64`, with log
`.local/linux-original-thumbnail-arm64-build.log`. AMD64 v26 has not started yet; wait
for the still-running AMD64 v25 build rather than duplicating its FFmpeg compilation.

ARM64 v26 completed as
`sha256:4319b4b9dd675d8a4df71b229dd36c0095a7699727fea1f04cf9ae017b27d76a`.
All fifteen embedded tests pass without host mounts, under the same offline read-only
container restrictions and normal codec limits used for v25. This includes independent
original-source thumbnail generation, the 1-pixel main / 8×4 thumbnail regression,
source-cleanup failure handling, and preserved filenames through worker staging.
AMD64 v25 was polled and remains live compiling FFmpeg; v26 AMD64 remains unstarted.

AMD64 v25 subsequently completed as
`sha256:7639b0496f59ca92dfcfdb8f9492dae714708a5fb16517b8bcd6b3d0124f91ca`.
All fifteen embedded tests pass under AMD64 emulation, with the same offline container
restrictions and 4 GiB codec address-space allowance used for earlier emulated runs.
Native AMD64 acceptance under the normal 512 MiB address-space bound remains unproven.

AMD64 v26 also completed as
`sha256:91f4d1f6d7759ed56ffc09165645b74e4a3d376ebd54d2645b326d50152350e1`;
all fifteen embedded tests pass under the same emulation and container limits. This covers
the independent original-source thumbnails and preserved filenames on both packaged
architectures. No builds or test runs remain running. Further sampling evidence is
recorded in [resize parity](RESIZE-PARITY.md), including 24 pinned-renderer references.
