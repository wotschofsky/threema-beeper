# Bridge licensing and provenance

Project-owned bridge additions are MIT-licensed. Upstream files retain their original licenses and
notices; this decision does not relicense them.

The complete pinned Threema Desktop checkout is kept under `.local/sources/threema-desktop`;
tracked overlays and patches describe this project's modifications. Preserve its `LICENSE.txt`, `LICENSE-3RD-PARTY.txt`, `.licenses/`, package licenses,
vendored Rust notices, and source provenance. Desktop package metadata says AGPL-3.0+; vendored
libthreema crate declarations must be preserved individually. Do not flatten these into a claim that
all upstream source has the same SPDX identifier.

Matrix appservice bridge is Apache-2.0. Its source is inspected separately and its original license
must accompany any redistributed dependency. The production bbctl build now includes the tracked
`native/bbctl/account-status.patch` for status reporting and durable transaction recovery. Preserve
its upstream notices, pinned source revision, full patch and generated binary checksum manifest;
the downloaded stock binary's checksum does not identify this modified build.

Before a private release, generate an SBOM from the actual installed npm, Cargo, native-library,
container, and executable inputs. Keep complete corresponding source, patches, build instructions,
and exact revisions with the release. Current image inventories are documented in `SBOM.md`;
their explicit coverage gaps prevent a complete SBOM or reproducible-release claim.

`PRIMARY-SOURCE-BUNDLE.md` describes the separate, verified primary-repository source supplement.
It preserves exact candidate revisions and original notices, including tracked bridge patches.
It does not yet cover all transitive dependency source and license obligations.

Gate 0B: preservation and provenance plan recorded. Formal review of upstream license obligations
blocks distribution or access by another user.

The modified Matrix bot SDK files in `integrations/matrix/overlay` retain upstream's MIT license,
with its complete notice alongside them. The overlay manifest records the package version and
original source-file hashes; the npm lock pins the package tarball integrity. Project-owned storage
adapters and preparation scripts remain MIT-licensed.
