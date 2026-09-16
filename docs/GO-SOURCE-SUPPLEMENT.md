# Go source release for the proxy compiler version

`python3 scripts/collect-go-source.py .local/go-source-NEW` downloads the official source archive
at the exact Go version recorded by the proxy build. Python 3.11 or later and that installed Go
version are required. The destination must be new and under `.local`.

`GO-SOURCE-PINS.json` records the official HTTPS download URL, archive size and SHA-256 checksum.
The collector checks all three against the received file, verifies `go/VERSION`, and compares
regular files under `go/src` with the installed toolchain source tree without running any
downloaded code. The complete original source archive, including notices, is retained.

The observed Go 1.27.1 archive contains 38 conventionally named notice files. Of the source files
compared, 11,945 match the installed source tree byte-for-byte, 67 are absent from that installed
tree and none differ. `GO-SOURCE-VERIFICATION.json` records the comparison and evidence hashes.
The missing-file list is preserved in full; it is not silently discarded.

The checksum originates from the official Go download metadata over HTTPS, not an independent
signature. Matching source files and version labels do not attest how the installed compiler was
built or prove reproducible proxy binaries. Those provenance and build requirements remain open.

The combined source exporter includes this archive and the patched proxy/vendor supplement.
It checks their Go versions, primary repository revision and the tested proxy binary hashes.
The production image still contains only the proxy executable, not the Go toolchain or sources.
