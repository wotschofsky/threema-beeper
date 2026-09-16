# Debian package notices and source requirements

`python3 scripts/export-os-notices.py .local/os-notices-NEW` collects package metadata and
license material from the two immutable tested Linux images. It requires Docker, Python 3.11
or later, and a fresh output directory under `.local`.

The collector creates read-only inspection containers with networking disabled and no mounts,
copies `/var/lib/dpkg/status`, `/usr/share/doc`, and `/usr/share/common-licenses`, then removes
the containers. It never starts them. The archives remain unextracted on the host.

The installed package set must match the checksum-verified image SBOM exactly, including version
and architecture. Copyright paths are resolved through archived symlinks without following host
filesystem paths. Original documentation and common license texts remain intact in the archives.
`os-notices.json` records each package, resolved copyright hash, exact Debian source-package name
and source version. `SHA256SUMS` covers all six copied archives and the manifest.

The observed result in `OS-NOTICE-VERIFICATION.json` covers 85 installed packages per image.
All copyright paths resolved, and all source-name/version mappings independently agree with the
SBOM metadata. Across the two images, 59 distinct source-package versions still need fetching
and verification. That list is recorded as `sourcePackagesRequired`.

Preserving installed notices does not establish that all license conditions have been reviewed,
that source archives have been collected, or that a complete release can be redistributed.
Those requirements and full target-host acceptance remain open.

## Exact source download and verification

```sh
python3 scripts/collect-debian-sources.py .local/debian-sources-NEW
python3 scripts/verify-debian-sources.py .local/debian-sources-NEW \
  .local/debian-sources-NEW/verification.json
```

The collector runs apt in an isolated container using the already-pinned arm64 image. Its only
host mount is the new source-download directory. Apt uses Debian's archive keyring and HTTPS
source repositories for trixie, trixie-updates and trixie-security. It downloads exact requested
versions without installing packages, extracting source trees or executing package code.
The container is removed automatically. Root capabilities are limited to the user/group and
filesystem operations apt needs; the live service and account storage are not mounted.

Every request has a recorded result and fetch log. Missing versions are reported as failures,
not replaced. The collector preserves source descriptors, payloads, apt's source-package records
and the repository indexes. The verifier requires the finished request list, exact source names
and versions, matching descriptor/index SHA-256 entries, and matching payload sizes and hashes.

The observed collection verified all 59 requested source-package versions with no unresolved
downloads. `OS-SOURCE-VERIFICATION.json` identifies the preserved archive and evidence. Apt
reported nonfatal chmod warnings in its temporary download directories; index processing and
all downloads completed, and the independent descriptor/payload checks passed. Earlier failed
setup attempts are separate from this verified collection.

This closes the identified Debian source-download gap for these images. It does not demonstrate
reproducible OS builds, a complete bridge source release, or full license-condition review.
