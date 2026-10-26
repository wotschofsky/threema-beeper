# Primary source supplement

Run `node scripts/entry.export-primary-source.ts .local/primary-source-NEW` to preserve the
primary repositories associated with the current Linux alerts candidate. The output directory
must be new. This command uses local Git objects and does not download dependencies, read
account data, start the bridge or modify the existing image export.

The bridge revision comes from `LINUX-ALERTS-VERIFICATION.json`. Upstream revisions come from
`docs/SOURCE-PINS.json` **at that bridge revision**, rather than current checkout branches.
The bridge archive includes its tracked overlays, patches and build instructions; upstream
archives contain their original source. Apply modifications using those preparation/build
instructions. Local checkout modifications and untracked root planning files are excluded.

Each archive retains its original directory structure and license notices. The exporter checks
the archive file list against the complete Git tree, rejects unresolved submodules, and compares
archived license/notice contents with Git blobs. `source.json` records revisions, file counts,
notice hashes, archive hashes and the candidate verification-record hash. `SHA256SUMS` permits
checking the output independently with `shasum -a 256 -c SHA256SUMS`.

This is a **primary source supplement**, not a complete corresponding-source release or legal
approval. Transitive registry/Git sources, native and OS dependency source archives, their notice
coverage, and complete build-input coverage still need collection and verification. The existing
private candidate remains unchanged; this supplement does not remove its release limitations.

The additional Matrix native Rust dependency export is documented in `MATRIX-DEPENDENCY-SOURCES.md`.
It collects the remote packages in that library's pinned lockfile separately from these primary
repositories; it does not close source coverage for the rest of the runtime.
The Threema WASM workspace's remote Cargo packages are collected separately as documented in
`LIBTHREEMA-DEPENDENCY-SOURCES.md`; its local workspace crates and patches remain in the primary
Threema Desktop source archive.
`NATIVE-SOURCE-SUPPLEMENT.md` covers the nine pinned Node and codec source archives, with
verbatim notices, native build recipes and patches from the tested candidate's source revision.
`DATABASE-SOURCE-SUPPLEMENT.md` preserves the packaged SQLCipher/BearSSL and Argon2 native
inputs and records the outstanding SQLCipher preferred-source/regeneration limitation.
`NPM-PACKAGE-INPUTS.md` describes preserved context-pinned npm package inputs selected by the
actual image inventories, including local modifications and explicit remaining coverage gaps.
`BASE-PACKAGE-INPUTS.md` preserves Corepack and Yarn files from the tested images without
starting a container or mounting account storage.
`OS-SOURCE-NOTICES.md` covers Debian package notices, exact source-version mappings, and the
verified source archives now included by the combined supplement exporter.
`PROXY-SOURCE-SUPPLEMENT.md` and `GO-SOURCE-SUPPLEMENT.md` cover the patched proxy, its
binary-linked vendored modules, and the official source release for its compiler version.
