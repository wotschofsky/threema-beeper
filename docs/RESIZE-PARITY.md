# Resize parity investigation

`pnpm run probe:resize-renderer` extracts and executes the pinned Desktop `downsizeImage`
function in Electron 40.10.0 / Chromium 144.0.7559.236 with a temporary offline profile.
It generates PNG gradients, checkerboards, transparent edges and coordinate grids at 32×32 and 17×13,
then downsizes each to maximum sides 16, 8, 4 and 1 (32 outputs). The report records the
upstream function source hash, runtime versions, synthetic RGBA inputs and decoded PNG
output RGBA. Committed references are `tests/fixtures/renderer-resize.json` (base64 pixels).
Fresh results and filter comparisons are `.local/renderer-resize-report.json`.

The probe compares FFmpeg bicubic, bilinear, area and Lanczos filters at the same output
dimensions. None matches every renderer fixture. On 32×32 gradients, area scaling matches
sides 16, 8 and 4 exactly, but differs at side 1. On checkerboards it differs even at
integer reductions. Across both source dimensions, maximum RGB errors are 53–60 for
gradients and 104–113 for checkerboards. This disproves simply changing the FFmpeg filter
as a complete parity fix. Repeated downsampling/mipmap selection is a hypothesis for the
next investigation, not yet established by these comparisons.

The report retains both raw RGBA errors and errors after black compositing (plus alpha).
Hidden RGB can differ by 255 without being visible; maximum visible error for the alpha
edge fixtures is still 32–33 levels across the tested filters. The alpha comparison here
uses raw straight-alpha FFmpeg scaling, which matches the current PNG path; it does not
model the JPEG path's explicit flattening before resizing. Fixing PNG alpha interpolation
and determining Desktop's sampling algorithm remain required before claiming parity.

These are measurements, not passing production acceptance tests. They cover small
synthetic PNG inputs, not EXIF orientation, ICC conversion, HDR, very large images or
resource exhaustion. The probe reports mismatches deliberately and does not silently
rewrite committed references from native output.

## PNG alpha interpolation fix

The PNG pipeline now converts to planar 16-bit RGBA, premultiplies RGB by alpha, resizes
color and alpha together, then unpremultiplies before PNG encoding. Transparent hidden RGB
becomes zero, matching the renderer's transparent output, instead of bleeding into visible
edge pixels. An explicit alpha quantization step compensates for FFmpeg's 16-to-8 alpha
conversion: even an unscaled round trip otherwise changes 128 to 129. The regression checks
every alpha value 0–255 unchanged at original size, transparent black, and the renderer
fixture's visible blue edge at four resize levels without contamination by hidden red.

All six local codec/AVIF/preparation cases pass after this change. Sampling and alpha-edge
coverage can still differ from the renderer because the resize filter is not yet equivalent.
This fixes the source-color contamination rather than claiming full resize parity.
The earlier comparison report describes straight-alpha scaling and remains evidence for
the previous bug; it is not a measurement of the corrected pipeline.

Context v27 was staged during investigation with the rejected float-alpha conversion.
It was never built and must not be used for validation. A fresh v28 context will contain
the final 16-bit path, exact alpha-ramp test and committed resize references.

v28 context: `40c9c9edb68eddc21fe99cc2027e9ab2548b545e750a3c4ea80a9b8a8d96a1df`.
Both builds started as `threema-beeper-service:png-alpha-{arm64,amd64}`, with logs
`.local/linux-png-alpha-{arm64,amd64}-build.log`. Integrated Linux test results are pending.

Both v28 images completed and pass all fifteen embedded media tests:

- ARM64: `sha256:b637c4624e8b8c48c72850286c88d42b178c16da2039018f27a8d1c5c61ff441`
- AMD64: `sha256:f157dd75f9e0dae893fac11806a4736467d52e5fb583222ee1ab727f3d9e851d`

Runs used no network or host mounts, a read-only root, dropped capabilities,
no-new-privileges and a 768 MiB container limit. Codec address-space limits were 512 MiB
on ARM64 and 4 GiB under AMD64 Rosetta emulation. Native AMD64 acceptance at 512 MiB
remains unproven. This validates the alpha fix, including the full 0–255 alpha ramp,
with packaged codecs; it does not establish full resize parity.

## Pinned Skia investigation

[Chromium's exact DEPS file](https://raw.githubusercontent.com/chromium/chromium/144.0.7559.236/DEPS)
pins Skia to `2708a1b1540e59b8e3407405b0c991a5c7b69523`.
The [mipmap implementation](https://raw.githubusercontent.com/google/skia/2708a1b1540e59b8e3407405b0c991a5c7b69523/src/core/SkMipmap.cpp)
builds successive half-size levels, flooring dimensions and retaining at least one pixel.
The [HQ downsampler](https://raw.githubusercontent.com/google/skia/2708a1b1540e59b8e3407405b0c991a5c7b69523/src/core/SkMipmapHQDownSampler.cpp)
uses box filtering on even axes and overlapping 1:2:1 triangle weights on odd axes, with
integer truncation. An alternate drawing downsampler also exists; this source inspection
alone does not prove which path executes for every canvas operation.

A local model (`.local/avif-fixtures/resize-model.py`) premultiplies 8-bit RGBA, applies
these integer-weighted reductions, selects a level based on the scale, samples bilinearly,
then unpremultiplies. It exactly matches all twelve 32×32 fixtures across sides 16/8/4/1,
including transparent edges. It does not match all 17×13 fixtures: some mismatches remain
large. Changing the level bias also fails those fixtures. Neither partial model is wired
into production. Next work must determine the actual level selection, coordinate mapping
and rounding for odd dimensions rather than treating square power-of-two agreement as
general acceptance. Downloaded source evidence stays under `.local/avif-fixtures`.

The probe now also draws each original bitmap directly at low, medium and high smoothing
quality, retaining each mode's RGBA alongside the actual function output. All 24 direct
medium results equal the function results, checked explicitly. For the 17×13 gradient and
checkerboard resized to sides 16 and 8, all three modes produce identical output; at sides
4 and 1, low differs while medium and high agree. Thus the odd-size disagreement cannot
be resolved just by adjusting the HQ mipmap averaging weights: level-selection/fallback
and bilinear sampling must be traced as well. A trial one-pixel coordinate shift did not
match the gradient and edge cases and was rejected. The pinned raster pipeline source is
saved locally as `SkRasterPipeline_opts.h` for the next fixed-point sampling investigation.
No production sampler was changed based on these incomplete models.

Eight coordinate-grid references were added without changing the original 24 reference
outputs. Decoding each opaque synthetic PNG in the renderer preserves every input pixel,
now asserted by the probe. At 17×13 → 8×6, coordinate-grid values follow the expected
pixel-center positions (first output row R=4,19,34,49,63,78,93,108 for input R=7*x).
Thus a simple source offset or PNG decode corruption does not explain the high-contrast
checkerboard mismatch. Transparent source RGB is cleared at alpha zero, as expected.
The remaining investigation is interpolation arithmetic and the actual renderer path at
the observed quality-mode transition. The fixture expansion does not change production
code or establish a complete sampling implementation.
