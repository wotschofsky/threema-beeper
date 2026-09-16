# npm package input preservation

`python3 scripts/export-npm-inputs.py .local/npm-inputs-NEW` preserves installed package inputs
selected by the actual tested Linux image inventories. Python 3.11 or later is required. The
destination must be new and under `.local`. The command does not install packages, execute
package scripts, access accounts, or use the network.

The collector verifies the recorded context inventory digest, checks the amd64 and arm64 SBOM
hashes and image identities, and requires their npm name/version/location sets to agree. Each
selected file is checked against its context hash and mode before copying. Package names and
versions must match the inventory. Package-local modifications are retained exactly as staged.

The observed supplement contains 217 package entries and 7,195 files. Duplicate names at distinct
image locations remain separate; they may have different modifications or dependency contexts.
Nested `node_modules` are excluded from each snapshot and collected only where the image SBOM
lists them independently. `npm-inputs.json` maps numeric archive directories to original image
paths, versions, notices and per-file hashes. `SHA256SUMS` covers that manifest and the archive.

`NPM-INPUT-VERIFICATION.json` records the archive content/mode check and nine package entries
without conventionally named notice files. This flag calls for inspection; it does not establish
that a license notice is absent from source headers, readmes or another location.

Five image entries are outside this export: the bridge, Matrix framework and isolated runtime
dependency project are project-source repositories; Corepack and Yarn are base-image packages.
Their coverage must be tracked separately. The original primary-source supplement preserves
the project revisions, but this collector does not treat that as proof of complete npm coverage.
The separate `BASE-PACKAGE-INPUTS.md` export now preserves Corepack and Yarn from both tested
images, including original notices. Preferred-source coverage remains a separate requirement.

Installed packages may contain generated JavaScript or omit preferred source and build tooling.
This supplement preserves the actual staged inputs and notices; it is not a complete
corresponding-source release, package-origin attestation, or license-compliance approval.

## Follow-up notice evidence

`NPM-NOTICE-VERIFICATION.json` records a separate notice supplement. Run
`python3 scripts/collect-npm-notices.py .local/npm-package-inputs-20260916 .local/npm-notices-NEW`
to collect it again; this uses public npm metadata and Git access for the unresolved package
origins and never executes package code.

Seven flagged entries have preserved notice evidence: `cookie-signature`, `glob-to-regexp` and
`hash.js` include full notices in their READMEs; the two `simple-app` entries are examples inside
`pkginfo`, whose containing-package license is preserved; `mkdirp` and `postgres` have notices
at the exact Git revisions reported by their version-specific npm metadata. The collector
preserves full original files, metadata, Git tree listings and hashes.

Two entries remain unresolved. `ip-cidr` declares MIT, but no conventionally named root notice
was found at its recorded revision. `launder` declares MIT, but its version metadata has no
exact Git revision. Neither declaration is treated as a substitute for the missing notice
evidence, and no current-branch license has been substituted. Complete legal review and any
nested third-party attribution review remain open.
