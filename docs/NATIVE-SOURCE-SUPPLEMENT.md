# Native source supplement

Run `python3 scripts/export-native-sources.py .local/native-source-NEW` to collect the native
source archives from the tested Linux alerts build context. Python 3.11 or later is required.
The destination must be new. No network access or service startup is needed.

The collector reads the candidate's source revision, loads its archive pins from Git, and checks
the copies in the build context before exporting them. The nine archives cover Node, FFmpeg,
libjpeg-turbo, libwebp, OpenH264, Opus, libavif, dav1d and Little CMS. The original archives remain
unchanged. Recognized notice files are additionally copied verbatim into `LICENSES/`, with their
original directory structure and hashes recorded in `native-source.json`.

`build/` contains the tracked native build recipes, patches and Dockerfile at the candidate's
source revision, preserving executable file modes. The Node patch hashes are checked against
the recorded build pins. Keep the primary bridge source archive alongside this supplement for
the remaining preparation scripts and project configuration.

`SHA256SUMS` covers every exported file, including the manifest. Check it inside the export with
`shasum -a 256 -c SHA256SUMS` or `sha256sum -c SHA256SUMS`. The manifest binds the source inputs
to the candidate verification record and image IDs; it does not independently attest the builds.

The supplement preserves source and notices for these nine inputs, including nested dependencies
already shipped in their source archives. It is not a complete runtime source bundle: npm and
OS package sources, remaining native inputs, tooling coverage, license review and full release
acceptance remain open. Archive checksum verification does not upgrade previously documented
signature limitations. See `NATIVE-SOURCE-SUPPLEMENT-VERIFICATION.json` for the observed export.
