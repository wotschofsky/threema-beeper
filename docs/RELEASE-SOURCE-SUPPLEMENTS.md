# Source supplements in private candidates

The Linux candidate exporter includes `sources.tar.gz` and `source-supplements.json` alongside
the image, deployment, scanner and test-evidence archives. Both are listed in the candidate's
artifact hashes and `SHA256SUMS`. `release.json` explicitly retains
`completeCorrespondingSource: false` and `releaseReady: false`.

To generate only this part of the candidate:

```sh
python3 scripts/export-source-supplements.py .local/source-supplements-NEW
```

The destination must be new and under `.local`. Python 3.11 or later is required. The command
reads the verified source supplements and their evidence records; it does not access accounts,
start a service, fetch dependencies or export Docker images.

The bundle combines primary repositories, Matrix and Threema Rust dependency sources and
notice supplements, Node/codec archives, database native inputs, npm package inputs and
notices, Corepack/Yarn files from the base images, Debian source archives and notices, and the
patched proxy/vendor graph with the matching Go source release. Each included file must match its
recorded checksum. Source revisions and candidate image identities are checked where recorded.
Every archived file is read back and checked before the bundle is reported as successful.

The internal `sources.json` maps archive paths to original evidence paths and hashes. The
verification documents included in the archive retain their own scope and limitations.
Root planning documents and account/profile files are not selected.

This brings the collected material into the candidate artifact set; it does not close the
remaining source requirements. Preferred sources for generated npm code,
SQLCipher regeneration provenance, unresolved notices, complete tooling coverage, reproducibility
and signing remain open. See the individual supplement documents for the evidence and gaps.

The Debian supplement must cover exactly the source-name/version set required by the verified
OS inventory, with no unresolved downloads. Its request must match the recorded OS notices,
and the notice record must identify the current candidate images. All six copied OS metadata/
notice archives and the source download archive are included. OS license review and reproducible
build verification remain distinct from source collection.

Previously exported candidates are unchanged. The updated exporter must run successfully to
produce a new candidate containing these artifacts; a standalone supplement does not update an
older candidate's manifest or checksums.

The full exporter has now been exercised successfully for the private candidate recorded in
`LINUX-CANDIDATE-EXPORT.json`. All nine checksum entries passed; both Docker archive config
identities, deployment image references, and all 50 source archive entries were checked.
This is packaging verification, not a clean-host restore or deployment acceptance test.
That candidate predates inclusion of the Debian supplement. The latest standalone source-bundle
verification is recorded separately; a new full candidate export is required to include it.
