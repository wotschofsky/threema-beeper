# Base-image JavaScript package inputs

`python3 scripts/export-base-package-inputs.py .local/base-package-inputs-NEW` preserves Corepack
and Yarn as installed in the tested amd64 and arm64 images. It requires local Docker access and
a new output directory under `.local`; Python 3.11 or later is required.

The exporter checks immutable image IDs against the candidate evidence, creates read-only
inspection containers with networking disabled and no storage mounts, and copies only the two
inventoried package directories with `docker cp`. It never starts the containers. It checks
their state and removes each container before completing the export.

The copied tar archives remain unextracted. The exporter validates member paths, records file
hashes/modes and symlink targets, and checks package names and versions against the inventory.
Both architectures must have identical package contents. `base-package-inputs.json` records
the file inventories and archive hashes; `SHA256SUMS` covers the archives and manifest.

`BASE-PACKAGE-INPUT-VERIFICATION.json` records the observed export of Corepack 0.36.0 and Yarn
1.22.22 from both images. Their notices are preserved alongside their installed code. This
closes the installed-file preservation gap for these two base-image entries, but generated or
bundled JavaScript may need additional preferred source and build tooling. Source completeness,
license review and full release acceptance remain open.
