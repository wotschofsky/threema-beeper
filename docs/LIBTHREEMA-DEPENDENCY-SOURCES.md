# Threema WASM dependency sources

The source collector exports the registry/Git packages from the pinned `libthreema` workspace
without compiling or running dependency code. It uses Rust 1.94.0 explicitly, so upstream's
less-specific toolchain file cannot select a different patch release during collection.

```sh
node scripts/entry.stage-wasm.ts .local/wasm-vendor-context-NEW vendor
docker buildx build --platform linux/arm64 --target artifact \
  --output type=local,dest=.local/wasm-vendor-sources-NEW .local/wasm-vendor-context-NEW
python3 scripts/verify-matrix-vendor.py .local/wasm-vendor-sources-NEW \
  .local/wasm-build-evidence-v2/cargo-metadata.json \
  .local/wasm-vendor-sources-NEW/coverage.json libthreema
```

The verifier is shared with the Matrix source collector. It checks the original Cargo lockfile
and recorded metadata against their evidence hashes, verifies every exported crate file against
Cargo's checksum inventory, and requires all remote dependencies in that metadata to be present.
It reports missing lockfile packages separately. Python 3.11 or later is required.

The export includes original notices, `Cargo.lock`, `Cargo.toml`, and Cargo's source replacement
configuration. The local workspace crates, patched `blake2` source and its notices remain in
the pinned Threema Desktop primary-source archive. Keep both archives together. When rebuilding,
adjust `/source-export/vendor` in the generated `config.toml` to the extracted vendor directory.

This workspace inventory includes optional features, build tooling and other targets; it is
larger than the dependency set compiled into the WASM artifact. Source collection does not
establish complete license compliance, reproduce the binary, or provide independent signed
provenance. Remaining toolchain/native/runtime sources and full release acceptance remain open.

`LIBTHREEMA-DEPENDENCY-SOURCE-VERIFICATION.json` records the checked export: all 333 remote
lockfile packages, including all 226 remote packages in the recorded metadata. It also lists
packages without conventionally named standalone notice files for follow-up review. This is
source inventory coverage, not a claim that every package was compiled into the WASM binary.

## Repository notice supplement

The 21 packages flagged for standalone-notice review have a separate supplement recorded in
`LIBTHREEMA-NOTICE-VERIFICATION.json`. Original notice candidates were recovered for all 21
from their recorded repository revisions, including license grants in `AUTHORS` files.

```sh
python3 scripts/collect-matrix-notices.py .local/wasm-vendor-pinned-sources-20260916 \
  .local/wasm-source-notices-NEW libthreema
```

The shared collector validates the component's coverage hash before any download. It normally
reads GitHub's source tree API; when that API reports an exhausted quota, it fetches the exact
public commit with Git and verifies the commit ID instead. Bare source caches are stored under
`.local/notice-source-git`. The supplement records which source-tree method was used and verifies
each downloaded notice against its Git blob identity. It never selects a newer revision.

This closes the identified notice-file collection gap, not a formal license review or a review
of every nested third-party attribution. Other source and release requirements remain open.
