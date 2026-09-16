# Experimental service container

The `service` target in `deploy/docker/Dockerfile.native` starts the real service
launcher. It is not a release image: it consumes the existing headless JS/WASM
artifacts, includes test/build sources, and installs Debian packages without a
snapshot pin. Live linked-account acceptance and complete release provenance,
SBOM and license aggregation remain unfinished.

Stage the installed dependencies and verified Linux Matrix/bbctl binaries using
`scripts/entry.stage-linux-native.ts` as described in `LINUX-NATIVE-BUILD.md`.
Build the service target explicitly (the default target runs tests):

```sh
docker build --platform linux/arm64 --target service \
  -f deploy/docker/Dockerfile.native -t threema-beeper-service:arm64 \
  .local/linux-native-context
```

Use `linux/amd64` and an AMD64 tag for the other architecture. Both targets use a
pinned Node 24.13.1 Debian bookworm base. The service runs as numeric UID/GID
1000:1000, with `tini -g` as its init and the TypeScript launcher as its child.
The default config path is `/config/bridge.yaml`; replace the container command
to supply a different path. No runtime dependency downloads occur.

The image installs its architecture's checksum-verified bbctl at
`/usr/local/bin/bbctl`, and provides WASM at `/app/libthreema_bg.wasm`, matching
`config.example.yaml`. To supervise bbctl, the configuration's optional `proxy`
section must reference that executable and its matching SHA-256 in
`docs/BBCTL-PINS.json`, plus private authentication and standalone registration
files. The image contains no such credentials. It does not register or link an
account automatically.

For a configured deployment, supply a private data directory owned by UID 1000,
private read-only secret files readable by that UID, and read-only configuration.
The service validates private-file ownership and modes; an ordinary world-readable
secret mount will be rejected. Use a read-only container root, drop all Linux
capabilities, set no-new-privileges, and provide a bounded writable `/tmp` plus the
configured data/media directories. The application-service listener stays on
container loopback; the supervised bbctl process connects to it from the same
container. Live outbound networking is required once accounts are configured.

The image deliberately fails with a fixed diagnostic and exit status 1 when its
configuration is missing. That is useful for checking the default entrypoint
without supplying account data, but is not a readiness or successful startup test.

## Verified on 2026-09-14

Both experimental service images built and passed all 13 native/backend/SDK/service
regressions when run through tini, with no network, read-only roots, capabilities
dropped and no host mounts. ARM64 ran in the native Linux VM; AMD64 used emulation.

- ARM64: `sha256:de78c81ea0d8e7865977c0dd9d05a8edaa79266cce6dce68a4823d2da5c12bf0`
- AMD64: `sha256:fdc886c9afa55c01e484ca304df8f186eacc0f992d3f8bd13307f67c1867021b`

The installed bbctl reported v0.15.0 on each architecture, using only temporary
empty configuration directories. The actual default entrypoints each emitted the
fixed missing-configuration diagnostic and exited with status 1. This is expected
for the credential-free smoke check.

`node tests/entry.container-signal.ts arm64` and the corresponding `amd64` command
both passed: image metadata confirmed numeric UID/GID and the intended entrypoint;
stopping a uniquely named synthetic container delivered SIGTERM to both its Node
parent and child, and the container exited with status 0 rather than being killed.
The tests removed their containers. This checks init process-group forwarding;
shutdown of a successfully linked bridge still needs live acceptance. Root
TypeScript checking passed.

## Build input integrity

Staging writes `context-integrity.json` with each regular file's size, mode and
SHA-256, plus each symlink's relative target and an aggregate SHA-256. The verifier
rejects absolute, broken and escaping symlinks, special files, extra/missing files,
changed bytes and changed file modes. Directory metadata and `.DS_Store` Finder
metadata are not inventoried. The generated `.dockerignore` also excludes Finder
metadata so it never enters an image.

Run `node scripts/entry.verify-linux-context.ts /absolute/staged/context` to check
a context. The Dockerfile's `inputs` stage performs this check after COPY, and
both the native builder and runtime consume files from that verified stage.

The 2026-09-14 verified context contained 7,389 regular files and 296 links:
`82cc8f56ca7368561d05443123ed4f5174ad3a041c8a327347c45cbe5e40fc85`.
The `inputs` target passed on ARM64 and emulated AMD64 with this same digest;
the service targets have not yet been rebuilt from this newest context. Mutation
and link-boundary tests and TypeScript checking passed.

This manifest detects drift from a recorded snapshot. It is not a signed
attestation, an SBOM, proof of upstream source authenticity, or proof of repeatable
compilation. A release must bind its trusted published manifest/digest to the
resulting image and supply the remaining source/toolchain provenance.

## Images rebuilt from verified inputs

Both service targets were rebuilt using the Dockerfile contained in the verified
snapshot above, then passed all 13 integration tests through tini again:

- ARM64: `sha256:128cde8905fe7ad308a7e838f0443dbf916ffebdae02b4daea04b206b05d56bf`
- AMD64: `sha256:f3ff8aa0e647414be5fdf5758f68954496138a3f31665c5480737cad34c86ae7`

`docs/LINUX-IMAGE-OBSERVATIONS.json` records the observed input-to-image mapping,
native addon hashes, bbctl hash, Node version, numeric user, Debian package
versions, and ldd results. All three native addons resolve their shared libraries
in both runtimes. These tests used no network, host mounts or account data.

Regenerate the runtime inspection with
`node scripts/entry.inspect-linux-image.ts /absolute/context arm64` (or `amd64`).
The inspector validates the host context, resolves the image tag to its immutable
local image ID, then inspects that ID with no network and a read-only root.
It checks the image's recorded context digest, native library resolution, numeric
UID, architecture, service entrypoint and installed bbctl checksum. The report
records local observations; it is not an independently signed build attestation.

## Runtime artifact trimming

The current runtime copies only `better_sqlcipher.node` and `argon2.node` from
the native builder. A separate runtime-input stage selects its own Matrix native
binary and bbctl, and places the headless bundle at its final path. Duplicate
`.artifacts` trees and native object files, archives and build tools never enter
the final image layers. Source files and JavaScript build tooling remain; further
release trimming and complete source-linked native SBOM coverage are outstanding.

Verified input digest:
`d0bca10cf7ecf26a884f37edbf4978506f1540ec2e6c38e030b698bbc4faaab4`.
The trimmed images are:

- ARM64: `sha256:cbb7b3764ab94b096d8bdc7d874b0e6a03ef40dad54b490642a8d09d74ab98dd`
- AMD64: `sha256:538a375c15cc153ce17e8c5e39c899bbc1320812ca2853658b32f7673e78fda0`

Both passed 13/13 integration tests, shared-library resolution, input/bbctl hash
checks, and explicit absence checks for duplicate architecture assets and native
build intermediates. Fresh SBOM scans found no T0Comp/.NET component and only the
installed architecture's bbctl. Current observations and SBOM coverage files refer
to these trimmed images; earlier hashes above are historical build results.

## Source-built Matrix crypto adoption

The current staging script requires validated local Matrix native source builds
for both architectures, re-runs their artifact audits, checks the indexed report
hashes and source pin, and records `matrix-native-artifacts.json` in the image.
It no longer stages the downloaded Matrix release binaries. See `SBOM.md` for
source-build commands and limitations. Runtime inspection verifies the installed
addon hash against this staged manifest.

Context `.local/linux-native-context-v13`, digest
`df8963635faa22fc00e1f6ad7d5f00f9a2a860a871d6366a1f4b5a9732f6709b`, produced:

- ARM64: `sha256:044f4a9e02bafc97f4cf5a1235e80b315a741121dca5a20b3d6b7fa8dc4c4f01`
- AMD64: `sha256:3b1086bced1aee05b82d3f88e302325ef45c020af1be362b211c199ca026175b`

Both passed all 13 native/service integration tests without network or host
mounts, with a read-only root, non-root user, dropped capabilities and temporary
scratch storage. Runtime inspections also passed. `LINUX-IMAGE-OBSERVATIONS.json`
now references these images; the trimmed release-addon image IDs above are
historical. The build still consumes a prebuilt headless JS bundle and WASM;
this is not yet a complete reproducible release pipeline.
