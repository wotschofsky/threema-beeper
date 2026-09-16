# Connection-status proxy source supplement

`python3 scripts/export-proxy-sources.py .local/proxy-source-NEW` preserves the patched proxy
source and its Go vendor graph. It requires Python 3.11 or later, the recorded Go 1.27.1 toolchain,
and the checksum-verified module cache used by the build under `/private/tmp/threema-go`.
The destination must be new and under `.local`.

The exporter verifies the source archive and both patches against the proxy build manifest,
and checks the two binaries in the tested Linux context against that manifest's checksums.
`go version -m` reads embedded module metadata without executing either binary. Both architecture
graphs must agree. `go mod verify` checks cached dependencies, then `go mod vendor` preserves
the relevant package sources and notices with network module fetching disabled. The locked
`go.mod` and `go.sum` must remain unchanged after vendoring.

The observed archive contains 1,114 files and 31 vendored modules, covering all 30 dependency
modules recorded in each binary. Every binary module must appear in both the vendor graph and
the locked sums. The extra vendor coverage comes from the wider project package/test graph;
it is not proof that every vendored file contributes bytes to the proxy executable.

`proxy-source.json` lists every file, hash and mode; `SHA256SUMS` covers that manifest, the source
archive and the module-verification result. `PROXY-SOURCE-VERIFICATION.json` records successful
archive readback and mode checks. No proxy process or linked account was started.

This is a separate source supplement, not an addition to the production image. The runtime still
ships only the proxy executable. Standard-library/toolchain source, full dependency repositories,
reproducibility, signing and formal license review remain separate requirements.

The official source archive for the compiler version is now preserved separately as documented
in `GO-SOURCE-SUPPLEMENT.md`. Its installed-source comparison does not constitute a compiler
build attestation. Both supplements are included by the combined source exporter.
