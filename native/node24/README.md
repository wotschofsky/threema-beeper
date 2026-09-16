# Node 24 cleanup compatibility experiment

The unmodified Node 24.21.0 Linux images abort during SQLCipher statement cleanup
in `tests/entry.media-replies.ts` and `tests/entry.recovery-controls.ts` on both
architectures. Node 24.18.1 passes, but is only an interim compatibility candidate.
This experiment tests the upstream fix while retaining the newer runtime.

Upstream changes:

- [Cleanup registry, 68321eff](https://github.com/nodejs/node/commit/68321eff80918e324e9fdaf1aa8cee6db14b84f7)
- [Cleanup callback lifetime, 03e2b9bc](https://github.com/nodejs/node/commit/03e2b9bc42ae9c7ed4fbab5509d70fa934863c44)

`upstream-*.patch` preserve the original patches. `cleanup-hooks.patch` combines
them for the official 24.21.0 source archive. The runtime changes and C++ environment
test apply unchanged. The worker-addon test uses Node 24's `context->GetIsolate()`
call sites and explicitly checks hook removal outside the active context.
No cleanup hook is disabled. Node's source license remains in the source archive.

`docs/NODE-CLEANUP-BUILD.json` records source and patch hashes. The archive checksum
was compared with the signature-verified official checksum list. The signer is
the release key listed in Node’s README; the pinned official public keyring
revision, fingerprint and evidence hashes are recorded in that JSON file. This
verifies the official input archive, not the locally patched output binary or
runtime approval. Verification used an isolated GnuPG directory and no account keys.

Build the experiment with the archive and adapted patch in a local context:

```sh
docker build --platform linux/arm64 \
  -f deploy/docker/Dockerfile.node-cleanup \
  -t threema-node-cleanup:arm64 .local/node-cleanup-review
```

The Dockerfile verifies both inputs, applies the patch without fuzz, builds Node
and runs the upstream C++ cleanup regression plus the worker-addon test.
The worker test builds against the installed headers and exercises main-thread,
worker, combined and repeated-worker cleanup. The experiment is separate from
`Dockerfile.native`; no running installation or release tag is changed.

ARM64 compilation and the cached follow-up build passed: one selected C++
regression and all four worker-addon cases ran successfully. Replacing only Node
in the existing 24.21 bridge test image then passed all four original failing
bridge cases and 13 native codec checks. The broader checks passed 17 cases on
the first loadable set, nine profile/history-window cases with the source overlay
mounted, and three compiled history-reader cases. The first broader attempt had
two missing-import failures; these are preserved in the evidence rather than
reported as passing. Current test fixtures were mounted read-only where needed.

Equivalent AMD64 verification is pending; that source build is now running.
`docs/NODE-CLEANUP-BUILD.json` records immutable ARM64 image IDs and log hashes.
If accepted, integrate the source build with checksum-bound staging, inventory,
license/source records and the runtime inspector before regenerating release
artifacts. Do not copy this executable into a running linked installation merely
because it compiled. These checks do not rebuild the current application release,
complete dependency review, or prove live target-host behavior.

The first ARM64 build predated the worker-test step. The follow-up build reused
its compile layer and ran both the explicit regression-selection check and the
worker-addon step successfully.

Signature evidence is under `.local/node-cleanup-review/`: `SHASUMS256.txt.asc`,
`nodejs-keyring.kbx`, `SHASUMS256.verified.txt` and `signature-extract-status.txt`.
GnuPG’s extracted cleartext has an additional trailing blank line; checksum entries
match the separately downloaded list. The source archive hash was checked against
the extracted, verified list. The installed gpgv reported a valid signature but
did not emit cleartext with `--output`, so `gpg --decrypt` was used to extract it
and its `VALIDSIG` fingerprint was checked again before accepting the checksum.
