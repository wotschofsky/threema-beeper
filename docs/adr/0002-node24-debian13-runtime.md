# Node 24 LTS on Debian 13

Status: the current recipe builds Node 24.21.0 from the verified source archive
with the recorded upstream cleanup-hook backport. Experimental ARM64 runtime
checks and 55 current-package tests plus 13 codec tests pass. The AMD64 runtime
also passes the original four bridge regressions, C++ cleanup test and four worker
cases. Both current packages now pass native inspection, 55 application and
maintenance tests and 13 codec tests. Release acceptance remains pending. The unpatched
24.21.0 candidate failed the database tests below. Running
installations and exported images are unchanged.

## Reason

The previous Node 24.13.1/Debian 12 image retained critical package findings after
all available Debian 12 upgrades. Debian records fixed versions of glibc and
OpenSSL in Debian 13 that were unavailable in the checked Debian 12 repositories:
[CVE-2026-5450](https://security-tracker.debian.org/tracker/CVE-2026-5450) and
[CVE-2026-75803](https://security-tracker.debian.org/tracker/CVE-2026-75803).
The specification requires the current Node 24 LTS line, not an indefinitely
frozen patch release. [Node 24.21.0](https://nodejs.org/en/blog/release/v24.21.0)
also updates its bundled OpenSSL to 3.5.8.

## Implementation

The addon builder and runtime stages now inherit the source-built Node runtime.
The base is official `node:24.21.0-trixie-slim` pinned to index
`sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590`.
Source and patch checksums, signature verification and experimental test results
are recorded in `NODE-CLEANUP-BUILD.json`. The runtime recipe includes the selected
C++ cleanup test and all worker-addon cases before copying the installation.
Database addons are rebuilt against those same installed headers. Runtime dependency
trimming, non-root execution, core-dump limits and the status proxy are retained.
The inspector requires Node 24.21.0 and Debian 13 and records the executable hash.
The source archive is excluded from the runtime payload. GnuTLS is absent in this minimal
runtime; if introduced, it must meet the fixed Debian 13 version baseline.
It also requires the fixed glibc, Perl and OpenSSL Debian 13 package baselines.
Debian records the Perl baseline `5.40.1-6+deb13u1` as fixed for the previously
scanned [Archive::Tar](https://security-tracker.debian.org/tracker/CVE-2026-42496),
[Socket](https://security-tracker.debian.org/tracker/CVE-2026-12087), and
[Storable](https://security-tracker.debian.org/tracker/CVE-2026-57433) findings.

The separately source-built Matrix native addon and WASM retain their pinned
build inputs. Compatibility with the new runtime must be tested; their older
build base does not itself prove or disprove runtime compatibility.

## Acceptance and limitations

Require both architecture builds, native library resolution and actual native
module use, bridge package regression tests, codec encode/decode tests, backup
restoration, and fresh image inventories/scans. Existing predecessor test and
scan records do not prove acceptance for this base. No account relinking or data
migration is needed to build and test these isolated candidates.

APT repository resolution is still mutable. The pinned base and recorded package
versions provide traceability but do not yet make the complete source build
reproducible. Remaining source inventory, signing/provenance and release gates
remain separate requirements.

## Observed compatibility failure

Both architecture images built. The ARM image passed 13 real image/video/audio
checks and 25 package checks, but `entry.media-replies.ts` and
`entry.recovery-controls.ts` abort in `node::RemoveEnvironmentCleanupHook` during
native SQLCipher statement destruction. Both failing files also abort on amd64.
Direct execution of the recovery file reproduces the same failure, so it is not
limited to test-runner process isolation. Simple in-memory SQL loops and repeated
empty outbox reopen checks pass; these controls do not establish application
compatibility and were not substituted for the failing tests.

The installed ObjectWrap header registers/removes cleanup hooks, while the
[24.21.0 implementation](https://github.com/nodejs/node/blob/v24.21.0/src/api/hooks.cc)
requires an active environment during removal. The upstream implementation has
a registry-based correction for removal outside the active context; the related
[upstream issue](https://github.com/nodejs/node/issues/65262) describes this API
interaction. The checked Node 24 branch still uses the older removal implementation.
This supported the initial cleanup-context diagnosis. Subsequent experimental
ARM64 checks with the backport pass; see the current verification section below.

Evidence: `.local/linux-trixie-tests-arm64.log`,
`.local/linux-trixie-database-amd64.log`, `.local/node2421-recovery-direct.log`,
and `.local/linux-trixie-codecs-arm64.log`. Both builds use context
`cc2c83fc7a4f6339d9a0b7b063eab8df157dfa3aca080bca660c3eecbd2316dd`.
The failed candidates must not replace release images. A preceding official Node
24.18.1/Debian 13 image is available for the next compatibility experiment at
index `sha256:ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc`.
Its acceptance requires rebuilt addons, the original failing tests and renewed
security review; locating its image does not establish suitability.

## Verified 24.18.1 candidate

Both architectures pass the original four failing-file checks, the other 25
package checks, and 13 actual media checks. Package checks include the status
proxy, backup restoration and recovery controls. `NODE-RUNTIME-PINS.json` records
image/context IDs and hashes of all six test logs. Native inspection records
`process.versions` and whether Node uses a shared OpenSSL library. The AMD64 media
checks use the documented 4 GiB address-space allowance under Rosetta; this is
not native x86-64 acceptance. Tests use no external networking or account mounts.

Fresh inventories detect 342 packages per image. The same pinned scanner/database
reports 1 critical and 69 high matches per image, with no suppressions.
`VULNERABILITY-SCAN.json` records the exact reports. The remaining critical match
is FFmpeg; `FFMPEG-CENC-REVIEW.json` now binds the verified source backport to
these build inputs and both image records.
Node itself bundles OpenSSL 3.5.7 statically, so the fixed Debian OpenSSL package
does not resolve review of that copy. This candidate is not release-approved.
The compatible patch pin is an interim experiment, not completion of the current
Node LTS requirement; evaluate a newer runtime or an independently verified fix
for the cleanup regression before promotion.

## Source-built candidate integration

The isolated ARM64 source build passes the C++ cleanup regression, four worker
cases, the four original bridge failures and 13 native media checks. Those results
are bound to immutable experimental image IDs and executable/log hashes in
`NODE-CLEANUP-BUILD.json`; they are not full current-package acceptance.

The current staging script verifies and includes the source archive and patch.
`Dockerfile.native` repeats the experimentally tested Node build steps and reuses
their content-addressed build cache where available. The first current ARM64
package build uses context
`1fe17fb3d09ee508c1a3e7be2294b2ffb63775308d9c9256a78a39e2df7a8a3c`.
Its log is `.local/linux-node-cleanup-build-arm64.log`. At integration time that
build and the isolated AMD64 runtime build were still running. Both current
packages need native, application, media and maintenance tests, refreshed
inventories/scans and release acceptance before replacing exported images.

The first ARM64 package passed its 22 regression/maintenance and 13 codec checks,
but the broader suite stopped before execution because several test files were
not staged. The staging list now includes those fixtures and the history-window
helper. The rebuilt package, context
`1563c932cabccbd569ee77dbb0bc91cc412b682cdfa2624154eed70af1fecb03`, passes native
inspection, all 51 selected package tests and all 13 codec tests without source
overlays. Its executable hash matches the verified experimental runtime. Exact
image identity and log hashes are under `verification.arm64.currentPackage` in
`NODE-CLEANUP-BUILD.json`. This establishes current ARM64 package compatibility;
AMD64, refreshed inventories/scans and target deployment acceptance remain open.

The isolated AMD64 runtime subsequently completed and passed all four original
bridge regressions, including the 100-cycle recovery case. Its executable and
image hashes are in `verification.amd64` in `NODE-CLEANUP-BUILD.json`. The current
AMD64 package is building from the same corrected context as ARM64 and reuses the
successful runtime layers; full application and media checks remain pending.

That AMD64 package subsequently passed all 51 selected package tests and 13 codec
checks, using the documented 4 GiB codec address-space allowance under Rosetta.
Both current images now have fresh inventories, comparison scans and source-fix
binding for FFmpeg. Raw findings remain unsuppressed; refreshed database scanning,
remaining dependency review, release provenance/exports and target acceptance
are still required. Neither exported images nor the live account were changed.
