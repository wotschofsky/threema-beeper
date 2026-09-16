# Native database source inputs

`python3 scripts/export-database-sources.py .local/database-source-NEW` exports the packaged
`better-sqlcipher` and `argon2` native inputs from the tested Linux alerts context. It verifies
the context inventory digest against both candidate images, then checks every selected file's
hash and mode. The destination must be new and under `.local`; no network or account access is
needed. Python 3.11 or later is required.

The observed supplement contains 50 files for `better-sqlcipher`
`12.10.0-sqlcipher4.16.0-bearssl0.6` and 25 for `argon2` `0.43.0`. It preserves the wrappers,
native C/C++ sources, build definitions, patches, original notices, and bundled SQLCipher and
BearSSL archives. Nested `node_modules` dependencies are excluded and still need separate
source coverage. `database-source.json` lists the exact files, hashes and original context paths.

Each package has a separate source/input archive. `SHA256SUMS` covers the archives, manifest
and unpacked files; check it inside the export with `shasum -a 256 -c SHA256SUMS` or
`sha256sum -c SHA256SUMS`. `DATABASE-SOURCE-VERIFICATION.json` records the observed archive
content and file-mode checks.

## SQLCipher source limitation

The bundled `sqlcipher.tar.gz` contains generated amalgamation C source and headers rather than
the original source tree. Its `deps/download.sh` names a private Threema Git repository and a
versioned BearSSL-provider branch for regeneration. This collector preserves that script without
executing it and retains the original source comments and notices inside the amalgamation.

These inputs can be used by the existing package build, but their presence does not establish
complete preferred-source or regeneration coverage. The upstream tree, modifications and exact
regeneration provenance still need to be obtained or verified before claiming complete
corresponding source. This supplement does not resolve formal license review or release approval.
