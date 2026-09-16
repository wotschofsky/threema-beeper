# Image SBOM generation and coverage

## Patched Node candidate (2026-09-16)

Both current packages have fresh Syft, CycloneDX and SPDX inventories under
`.local/sbom/2026-09-16-alerts`. The pinned scanner executable was verified;
the coverage audit accepts its exact image identity and rejects the previous
image observations. Each detects 341 packages: 222 npm, 85 Debian, 32 Go modules and
two binaries. No Rust crate metadata was detected. Exact identities, output hashes
and coverage limits are in `NODE-CLEANUP-IMAGE-REVIEW.json`.

The current scan reports 170 matches per image:
one critical, 64 high, 50 medium, six low, 44 negligible and five unknown. No
suppressions were applied. The separate database cache refreshed on 2026-09-16
returned the same latest available build; the current images were scanned against
that verified cache. That evidence is in `NODE-CLEANUP-IMAGE-REVIEW.json`. Static component
coverage, applicability review and release approval remain open.
The two-architecture `LINUX-IMAGE-OBSERVATIONS.json`, `SBOM-COVERAGE.json` and
`VULNERABILITY-SCAN.json` now describe these exact patched candidates. Both pass
86 package tests and 13 codec tests. The pinned js-yaml 4.3.2 and ip-address 10.3.1
dependencies remove their reported advisories from both inventories' scans.
The CIDR dependency update also drops two older transitive packages. Exported
release archives remain unchanged.

For an isolated candidate, pass its observation JSON as the optional third
argument to `entry.audit-image-sbom.ts`. The same identity and component checks
apply without replacing the existing release-wide observation index.

## Previous security-update candidates (2026-09-15)

Historical CycloneDX 1.7, SPDX 2.3 and Syft JSON reports for the previous security-update candidates are in `.local/sbom/2026-09-15-node2418/`. Their image indexes are retained in Git history. Each detected 342 packages: 223 npm, 85 Debian, 32 Go modules and two binaries, down from 523 packages before runtime dependency removal. The pinned scanner executable checksum was reverified.

Those previous candidates used Node 24.18.1 on Debian 13, retained npm removal, and included tar 7.5.21. They did not replace the exported release images or companion archives, which still describe the earlier monitoring build. Regenerate exports and checksums after the remaining security review and upgrades.

Node’s statically linked dependencies are recorded separately by the runtime inspector and need their own review. Coverage remains incomplete: FFmpeg identification does not inventory all statically linked codec dependencies, compiled Rust/WASM dependencies require the separate build/source records, and the scanner labels the bridge and patched bbctl revisions UNKNOWN. The release source commit and checksum-bound proxy manifest supply those revision references. These are dependency inventories, not vulnerability-scan results or signed provenance. Full release security acceptance is still open.

## Historical inventories

The records below describe earlier images and build participation. Their package counts and hashes must not be used as evidence for the current deployment images. The current JSON observation and coverage indexes supersede earlier indexes; Git retains the historical versions.

Syft v1.51.1 generated CycloneDX 1.7 JSON, SPDX 2.3 JSON and its detailed native
JSON report for both immutable service image IDs in `LINUX-IMAGE-OBSERVATIONS.json`.
The official macOS ARM64 tool archive was verified against both its GitHub release
API digest and published checksum list; `SBOM-TOOL-PINS.json` records these pins
and the extracted executable hash. No global tool installation was changed.

Reports are generated artifacts under `.local/sbom/2026-09-14/`:
`arm64.cdx.json`, `arm64.spdx.json`, `arm64.syft.json`, and matching AMD64 files.
`SBOM-COVERAGE.json` records their hashes, image/input IDs, component counts and
detected gaps. These artifacts need inclusion in the eventual release bundle;
generating them does not complete the release's SBOM acceptance.

The command used for each architecture is:

```sh
SYFT_CHECK_FOR_APP_UPDATE=false .local/bin/syft-v1.51.1/syft scan \
  docker:sha256:IMAGE_ID --platform linux/ARCH \
  -o cyclonedx-json=.local/sbom/2026-09-14/ARCH.cdx.json \
  -o spdx-json=.local/sbom/2026-09-14/ARCH.spdx.json \
  -o syft-json=.local/sbom/2026-09-14/ARCH.syft.json
```

Use the full image digest and `arm64` or `amd64` in place of the placeholders.
The explicit Docker source reads the local image; update checks are disabled and
no online enrichment was requested. See the [official Syft documentation](https://github.com/anchore/syft#the-basics).

Run `node scripts/entry.audit-image-sbom.ts .local/sbom/2026-09-14 arm64` (or
`amd64`) to check the scanned image ID against recorded observations, verify the
output format identifiers, check for key native/runtime components and record
file hashes and coverage. This is a coverage audit, not formal JSON-schema or
semantic conformance validation of every SBOM field.

Both image scans detected 580 packages: 390 npm, 92 Debian, 96 Go modules,
one binary and one .NET build-tool component. Multiple versions/declarations and
duplicate architecture binaries are present in these experimental images, so
these counts are not counts of unique live runtime dependencies. The scan finds
SQLCipher, Argon2 and Matrix crypto package wrappers and bbctl's Go dependencies.
It also detects the BearSSL T0Comp.exe build intermediate copied into the runtime.
That is shipped build material requiring removal, not a production .NET dependency.

No Rust crate metadata was detected for the compiled WASM or Matrix native
binaries. Their source dependency graphs must be inventoried and tied to exact
build inputs, features and resulting hashes before claiming complete coverage.
The bridge package also has no release version yet. SBOMs do not replace
vulnerability scanning, native license notices, signed provenance or release
trimming. Both coverage reports therefore explicitly remain `releaseReady: false`.

## Updated scan after runtime trimming

The current image observations and coverage summaries now refer to the trimmed
images documented in `CONTAINER-RUNTIME.md`. Their fresh reports are under
`.local/sbom/2026-09-14-trimmed/`, with the same architecture/format filenames.
Both have 515 detected packages: 390 npm, 92 Debian, 32 Go modules and one binary.
The BearSSL T0Comp.exe component is absent, and bbctl is present only at its
installed `/usr/local/bin/bbctl` path. Earlier counts/reports above describe the
untrimmed images and are retained for comparison. Compiled Rust/WASM coverage,
source/build-tool trimming and final release acceptance remain incomplete.

## Pinned libthreema Rust source inventory

`scripts/entry.libthreema-source-sbom.ts` now extracts Cargo manifests, Cargo.lock,
license files and the WASM build script directly from the pinned Desktop Git
commit, rather than scanning potentially changed working-tree files. It verifies
the Syft executable hash and confirms the upstream Cargo command still selects
`libthreema`, feature `wasm`, target `wasm32-unknown-unknown`, release profile and
locked resolution. Changed build selection requires explicit review in the script.

The verified source run produced CycloneDX, SPDX and Syft reports with 337 Rust
crate entries under `.local/sbom/libthreema-source-verified/`. Nine source inputs
and all report hashes are recorded in `docs/NATIVE-SOURCE-COVERAGE.json`, along
with the observed WASM hash. Regenerate into a fresh output directory using:

```sh
node scripts/entry.libthreema-source-sbom.ts /absolute/project/.local/sbom/fresh-source-report
```

This inventories the pinned workspace lockfile, including other target/feature
and tool dependencies. It does not prove which crates were compiled into the
observed WASM binary. Target/feature-resolved build metadata and a fresh build
linked to those records remain necessary. The tagged Matrix native crypto source
inventory is documented below; its compiled graph remains unproven. These source reports supplement, and do not silently
replace, the image SBOMs or their recorded coverage gaps.

## Tagged Matrix native Rust source inventory

The official annotated tag `v0.6.6` resolves to source commit
`d71b99cc0b5bd06597a7dc718a73eb4e4ff6d3f1`. Both tag-object and commit IDs are
recorded in `MATRIX-CRYPTO-PINS.json`; the checkout is pinned in `SOURCE-PINS.json`
and lives with the other clones under `.local/sources/`.

`scripts/entry.matrix-source-sbom.ts` reads the native library's Cargo manifest,
lockfile, license, package metadata and release workflow directly from that commit.
It verifies the release package version and installed SBOM tool hash, extracts
locked Git dependency sources and the declared Rust toolchain, and rechecks both
Linux native binary sizes/hashes against the release pins before generating
CycloneDX/SPDX/Syft source inventories. The unrelated xtask tooling lockfile is
excluded from this native-library inventory.

The scan detected 326 Rust crates, including Matrix crypto/SQLite 0.18.0,
vodozemac 0.10.0, libsqlite3-sys 0.35.0 and napi 2.16.17. The lockfile references
Matrix Rust SDK commit `90db5fe383a9a325667c817e144ea6a711c90468`. The recorded
release workflow specifies `nightly-2026-06-04` and builds each target through
napi; the Cargo manifest enables bundled SQLite by default.

Reports are under `.local/sbom/matrix-native-source/`; input, report and native
binary hashes are recorded in `docs/NATIVE-SOURCE-COVERAGE.json`. Regenerate into
a fresh directory with `node scripts/entry.matrix-source-sbom.ts /absolute/project/.local/sbom/fresh-matrix-source`.
Both source inventories now exist, but their `compiledDependencySetProven` flags
remain false. A tagged Cargo.lock and matching release download hashes alone do
not prove that the upstream binary used that exact resolved dependency graph,
features or toolchain. Source-linked rebuild/attestation evidence remains needed.

## Observed WASM build dependencies

The WASM builder now exports Cargo compiler-artifact JSON, complete Cargo package
metadata, compiler versions and hashes alongside the generated web WASM. Staging
uses a Git archive of the pinned source and records the exact input tree digest.
Cargo's JSON replay runs after the upstream build/optimization with identical
package, feature, target and profile selection. The audit requires every replayed
unit to be cached; recompilation would invalidate the association with the
already-optimized artifact and is rejected.

The ARM64 Linux build/audit succeeded with 166 compiler units from 132 distinct
packages. Of these, 83 packages participate in WASM-target units and 73 in host
build units; some participate in both. This narrows the earlier 337-entry workspace
lockfile inventory without mislabeling host build tools as WASM runtime code.
The complete report records per-unit features, target kind, profile and package
metadata at `.local/wasm-build-evidence-v2/build-coverage.json`; its hash and summary
are in `NATIVE-SOURCE-COVERAGE.json`.

The optimized WASM SHA-256 is
`1b5caa61e88726635b5cbb8d5fb5cd00e23f6805f71334db060dbd278fbf65d6`, identical to
the existing artifact used by the bridge. Source-context digest:
`7d5ed9227ffa1859c40e4d6943604304898ec41ca4a6565b537a729486320904`.

To reproduce the evidence flow with fresh paths:

```sh
node scripts/entry.stage-wasm.ts /absolute/project/.local/wasm-source-fresh
docker build --platform linux/arm64 --target artifact \
  -f .local/wasm-source-fresh/Dockerfile \
  --output type=local,dest=.local/wasm-evidence-fresh .local/wasm-source-fresh
node scripts/entry.audit-wasm-build.ts .local/wasm-source-fresh .local/wasm-evidence-fresh
```

The initial metadata command filtered to the WASM platform and omitted five Linux
host dependencies; the audit rejected this mismatch. Complete metadata now lets
actual artifact records select build participation. The audit also rejected a
mutated replay that indicated recompilation after optimization. TypeScript checks
passed. Cargo artifact messages document build participation, including cached
units, rather than proving that every dependency leaves retained bytes after
linking or optimization. See the [Cargo artifact-message documentation](https://doc.rust-lang.org/cargo/reference/external-tools.html#artifact-messages).
An independent clean-build attestation remains outstanding; Matrix-native build
evidence is recorded below. Source SBOMs have not yet been transformed into final,
build-associated release SBOMs.

## Locally compiled Matrix native addon

`deploy/docker/Dockerfile.matrix-native` builds the pinned native crate using the
upstream workflow's `nightly-2026-06-04`, locked Cargo resolution, default bundled
SQLite, an explicit GNU/Linux target and release profile. It compiles the cdylib
directly with Cargo, copies it to the expected `.node` filename and strips it;
this is not a recreation of upstream's complete napi CLI/npm release process.

The ARM64 build succeeded from source context
`8598cdca9d1dfb0d272d54781a7c6cd3bd65b795b2d455061816f546fdee94df`.
The audit observed 277 compiler units from 228 packages: 177 native-target packages
and 91 host-build packages, with overlap. The addon SHA-256 is
`c9b70375643216e246636a5f2c1f816914b11f6cc9c8373e218a6039ca9d8d0f`, which differs
from the official release binary and is recorded separately.

Mounting only this addon read-only into the existing ARM64 service image passed
three tests: native encrypted-store persistence, two-device encrypted exchange,
and native bot/ghost session identity/HTTP routing. Networking was disabled and
all data was synthetic. This initial compatibility run used an addon mount;
subsequent image adoption is recorded below.

The AMD64 build from the same source context also passed the artifact audit and
all three compatibility tests in the AMD64 service image with networking disabled.
Its audit observed 279 compiler units from 230 packages: 178 native-target and
92 host-build packages, with overlap. Its addon SHA-256 is
`6208d5f54312cb76f1ff5a4816e6025f42281a97d62ca7bee7c1f61d574de735`, also different
from the published release. Evidence is in `.local/matrix-native-build-amd64/`
and `.local/matrix-native-build-amd64-tests.log`.

Commands, using fresh output directories:

```sh
node scripts/entry.stage-matrix-source.ts /absolute/project/.local/matrix-source-fresh
docker build --platform linux/arm64 --target artifact \
  -f .local/matrix-source-fresh/Dockerfile \
  --output type=local,dest=.local/matrix-evidence-fresh .local/matrix-source-fresh
node scripts/entry.audit-matrix-build.ts .local/matrix-source-fresh .local/matrix-evidence-fresh arm64
```

Cargo records, compiler details, input and output hashes, per-unit features and
compatibility results are indexed in `NATIVE-SOURCE-COVERAGE.json`. The audit
requires a successful build, resolvable artifact package IDs, correct target
paths, the expected bundled-SQLite cdylib, unchanged lockfile and matching output
hash. These records establish local build participation, not provenance of the
separately downloaded upstream binary. Signed/reproducible release evidence
remains incomplete.

Run `pnpm run test:native-build-audit` to verify rejection of failed build records,
missing package metadata, incorrect target paths, missing bundled-SQLite features,
and altered addon bytes. This uses synthetic artifact records; addon compatibility
is covered separately by the container tests above.

Both source-built addons have now been adopted into the experimental service
images recorded in `CONTAINER-RUNTIME.md` and `LINUX-IMAGE-OBSERVATIONS.json`.
Staging re-audits build evidence and checks indexed report hashes and source pins;
runtime inspection verifies the installed addon hash. Both images passed 13/13
native/service tests without host mounts or networking. This establishes tested
local image adoption, not a complete reproducible build or live-account validation.

Fresh Syft inventories for these source-addon images are in
`.local/sbom/2026-09-14-source-native/` (CycloneDX, SPDX, Syft and audit JSON).
Both audits matched the immutable image IDs. `SBOM-COVERAGE.json` now indexes
these reports. The image scan still does not recover compiled Rust crate metadata;
source/build participation records remain separate pending final SBOM assembly.

The current proxy pins golang.org/x/crypto v0.56.0 and x/text v0.41.0. Both image inventories confirm these versions; GO-2026-6303, GO-2026-6354 and GO-2026-6355 are absent from their fresh scans. Four uncached proxy status/spool tests passed before cross-compilation. Live services and exported releases are unchanged.
