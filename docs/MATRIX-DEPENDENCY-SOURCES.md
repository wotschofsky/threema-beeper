# Matrix native dependency sources

Collect the pinned Matrix encryption library's Rust dependencies without compiling or running
dependency code:

```sh
node scripts/entry.stage-matrix-source.ts .local/matrix-vendor-context-NEW vendor
docker buildx build --platform linux/arm64 --target artifact \
  --output type=local,dest=.local/matrix-vendor-sources-NEW .local/matrix-vendor-context-NEW
python3 scripts/verify-matrix-vendor.py .local/matrix-vendor-sources-NEW \
  .local/matrix-native-build-arm64/cargo-metadata.json .local/matrix-vendor-sources-NEW/coverage.json
```

The source collector uses the pinned Rust base and `cargo vendor --locked`. Network access is
needed for public registry/Git sources. It preserves source files, their original notices, Cargo's
per-file checksum inventories, the original lockfile, and source replacement configuration.
Python 3.11 or later is required for the verifier.

The verifier checks the lockfile against the pinned source evidence, recognizes only recorded
build metadata, checks every vendored file and registry package checksum, and requires coverage
of all external packages in that metadata. It records any lockfile packages absent from the
export separately. It refuses to overwrite an existing report. Git source identity relies on
Cargo's locked revision selection; the recorded file checksums are not independent Git attestations.

The recorded export contains all 325 remote lockfile packages, including all 320 remote packages
in the recorded build metadata. This includes dependencies for other targets and optional features;
it does not mean all 325 packages contribute bytes to the shipped binary. The primary Matrix
crate remains in the separate primary-source supplement.

The generated `config.toml` uses `/source-export/vendor`; adjust that directory to the absolute
location of the extracted vendor tree when rebuilding elsewhere. Keep the pinned upstream source,
toolchain and build instructions alongside it. License-file collection is not license approval;
packages without standalone notices still require review. Other runtime dependency sources and
full release acceptance remain open. See `MATRIX-DEPENDENCY-SOURCE-VERIFICATION.json` for the
archive and evidence hashes.

## Recovered repository notices

`MATRIX-NOTICE-VERIFICATION.json` records a separate supplement for the 37 packages whose
vendored trees had no conventionally named standalone notice files. It contains 34 unmodified
notice files from 26 exact repository revisions, with candidate coverage for all 37 packages.
The two `r-efi` versions keep their license grants and copyright information in `AUTHORS`.

To collect the supplement again:

```sh
python3 scripts/collect-matrix-notices.py .local/matrix-vendor-download-sources-20260916 \
  .local/matrix-source-notices-NEW
```

This requires public GitHub access. The collector derives revisions from the crates' recorded
VCS metadata, or the pinned Cargo Git source for Matrix SDK crates. It retrieves notices from
crate ancestor directories and their `LICENSES` directories, retaining original names and bytes.
Each file is checked against the Git tree's blob identity; the manifest records SHA-256 hashes,
source URLs, revisions, package mappings and tree evidence. A failed fetch leaves a partial
directory without a completed manifest; use a fresh destination on retry.
If GitHub's REST API reports an exhausted quota, the collector can fetch the exact public Git
commit and verify its identity instead. The manifest records that method; no revision changes.

The archive is separate from the checksum-verified Cargo vendor export. Candidate notice
coverage does not establish license compatibility or completeness of nested third-party notices.
Those reviews and source coverage for the rest of the bridge remain open.
