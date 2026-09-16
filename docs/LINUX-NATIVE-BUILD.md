# Linux native-dependency probe

This builds the installed upstream SQLCipher and Argon2 dependency sources for Node
24.13.1 on Debian bookworm/glibc. It is a feasibility image, not the bridge runtime.
The Node base is pinned by its multi-platform digest. Compiler packages currently
come from Debian repositories without snapshot pinning, so this is not yet a
reproducible release build.

From the project root, after installing upstream dependencies, download the two
Matrix crypto 0.6.6 assets listed in `docs/MATRIX-CRYPTO-PINS.json` into
`.local/bin/matrix-crypto-v0.6.6/`, retaining their exact filenames. The stager
verifies their size and SHA-256 against that manifest before copying either into
the context; its digests were retrieved from the official GitHub release API.
These are upstream Linux binaries, not locally compiled Rust artifacts.

Then run:

```sh
node scripts/entry.stage-linux-native.ts
docker build --platform linux/arm64 -f deploy/docker/Dockerfile.native \
  -t threema-beeper-native-probe:arm64 .local/linux-native-context
docker run --rm --platform linux/arm64 --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m threema-beeper-native-probe:arm64
```

Use `linux/amd64` and an `amd64` image tag for the second architecture. On an
ARM64 host that run uses emulation; it does not establish native AMD64 hardware
coverage. The staging command refuses to overwrite an existing directory; pass
a fresh absolute directory beneath `.local/` when restaging.

Only the required package dependency closure is copied. Host `.node` binaries, native SQLCipher/Argon2 `build` directories, `prebuilds`,
nested `node_modules`, and Git metadata are excluded. Published JavaScript
`build` directories are retained because some packages use them at runtime. The
staged manifest records package versions and package.json hashes; these hashes
are inventory information, not attestations of all package source bytes. No
profile, credentials, or account data is staged. Container compilation uses the
Node image's own headers and rebuilds both addons. The final probe runs as the
image's unprivileged `node` user on the same Debian base without compiler tools.

The existing persistence probe checks a committed encrypted WAL after SIGKILL,
wrong-key rejection, integrity, absence of the plaintext marker in the database,
and Argon2 hash/verify behavior. A separate Matrix native probe verifies encrypted
store reopening, stable identity, wrong-passphrase rejection, and decryption with
the persisted Megolm key. The Dockerfile runs these tests plus the patched SDK device-exchange probe (four
test cases total).
Matrix crypto, WASM and the complete bridge still
need integration into the production Linux image and its acceptance tests.

## Verified on 2026-09-14

ARM64 build and both runtime tests passed under OrbStack's ARM64 Linux VM on the
ARM64 Mac. The image was
`sha256:fc6359133ec4b1ce567409a59a88dc9cde0e40e9a02582b45b0af2ea3770b1a0`.
The final container had a read-only root, no network, all capabilities dropped,
no-new-privileges, and only a 64 MiB temporary filesystem for synthetic test data.
This is not target-host or complete bridge-image acceptance.

AMD64 SQLCipher/Argon2 source compilation and both tests also passed under
emulation, using image
`sha256:e7ba9741f315d9390076092074bdf585342d6fb3985b7505eef0c0cea98a8c80`.

The Matrix persistence probe passed on both architectures in these same Debian
runtimes, mounting the verified staged context read-only at `/crypto` and running
`node /crypto/tests/probes/entry.matrix-native-persistence-probe.ts`. That tested
the two verified release binaries with no network, credentials or account state.
The original image hashes above precede the new combined test command and do not
contain Matrix crypto; rebuilding the updated Dockerfile produces the combined
probe image. These original image hashes did not exercise the SDK transaction/device-exchange
path; see the combined-image results below.

## Combined SDK image

The stager now includes the installed patched Matrix SDK and its dependency
closure (162 packages in the verified staging run), along with the bridge's
SQLCipher portal/inbox stores, encrypted sender, and transaction decoder. The
runtime image contains these files; no host source mount is needed to run it.
Native compilation is a separate Docker layer from the Matrix/runtime files.

The ARM64 combined image
`sha256:3823dbee4a3798fa615b0bd0fa32f203a38dd25a37f8d7a09cdeda771f7e095b`
passed all four tests with the same non-root, read-only, network-disabled limits.
The SDK test uses synthetic Matrix endpoints and real device keys, signatures,
Olm/Megolm sessions and ciphertext. It checks both message directions, encrypted
reactions, durable transaction deduplication, store reopening, membership lookup
failure, session rotation on recipient removal, and exclusion of messages sent
while a recipient was absent even after they rejoin. It does not prove live
Beeper proxy compatibility or full Threema backend behavior.

The AMD64 combined image
`sha256:73fdfc596f7b2c6ed685412992c32dacce8e1475a6dfa2d786507c231351c6dd`
also passed all four tests under emulation, with the same restrictions and no
host mounts. Both combined runs exited successfully. These are dependency/SDK
feasibility images, not release images or full Gate 0E acceptance.

## Headless backend runtime

The image now also includes the existing headless Threema JavaScript bundle and
WASM artifact, and stages the bridge TypeScript source. `headless-artifacts.json`
in each context records the bundle/WASM sizes and SHA-256 hashes. These are
consumed build artifacts, not evidence of a reproducible upstream source build.
The host bundle has only Node built-ins, SQLCipher and Argon2 as runtime externals;
the latter two are rebuilt for Linux in the image.

The default suite now has nine cases: the previous four native/SDK cases, the
real headless initialization/database check, and four worker lifecycle cases.
These cover missing identity without relinking, cancellation, exclusive profile
ownership and clean ownership release. All profiles are synthetic temporary data;
the container has networking disabled and mounts no host profiles.

ARM64 image
`sha256:9cb46aabd8c2f93d744e89c2948d28fb5f0ed6914f6a5fca9b40445214de8df9`
passed 9/9 cases. This proves initialization and lifecycle behavior under Linux,
not successful startup of a linked service, live synchronization or sending.

AMD64 image
`sha256:efc403539e5b28ebaf6cfcf359ecad8ed1f8cfc62b7fcc8b21c4a982386e2767`
also passed 9/9 cases under emulation with the same isolation. Root TypeScript
checking passed after the staging changes. Native target-host and complete
service/production build acceptance remain outstanding.

## Service launcher and native session checks

The image now stages the application-service framework and explicit YAML parser,
with their installed runtime dependencies (222 packages). The suite adds native
bot/ghost session testing, encrypted service-store tests and missing-identity
launcher cleanup, for 13 total cases. Native sessions use synthetic HTTP responses;
this is not successful service startup with a real linked account.

Staging was corrected to resolve npm packages whose names also identify Node
built-ins (`string_decoder`), and to preserve published JavaScript `build`
directories such as OpenTelemetry's. Only native SQLCipher/Argon2 build folders
are omitted before rebuilding those addons for Linux.

ARM64 image
`sha256:826d893ed1118127a880cf3b1c41b8af221b20038c46ad220b38bf5f376a0293`
passed 13/13 tests with no network or host mounts, a read-only filesystem,
non-root user and 64 MiB tmpfs. Root TypeScript checking also passed.

AMD64 image
`sha256:000e806690bf7de2ce5c7f2873e0d268f67ee71ec41a15c32a1dd40480b222c5`
passed the same 13/13 tests under emulation with identical isolation. Both runs
completed successfully. Production packaging, upstream source-build reproducibility,
linked service startup, live proxy traffic and real Pi acceptance remain outstanding.

The current image staging step uses locally source-built Matrix addons, requiring
`.local/matrix-native-source-context` and both `.local/matrix-native-build-{arch}`
outputs plus their validated reports. Follow `SBOM.md` for the source-build steps.
`CONTAINER-RUNTIME.md` records adoption and the latest 13/13 results for both
architectures. Downloaded release addon pins remain comparison/provenance records,
but their binaries are no longer selected by the service staging script.

## Pinned codec source build

Run `pnpm run prepare:codec` before `entry.stage-linux-native.ts`. It fetches the
signature-verified FFmpeg release specified in `FFMPEG-PINS.json` and checks its archive hash.
The source archive stays in `.local/codec-sources`; staging includes a verified copy under
`.artifacts/ffmpeg` in the integrity manifest. `native/build-ffmpeg.sh` supplies the explicit
build configuration. The source archive is excluded from runtime layers; FFmpeg/ffprobe,
license notices, source pin and the generated build configuration are included.

This replaces Debian FFmpeg 5.1's GIF decoder, whose backward seeks fail with large piped GIFs.
The first FFmpeg 8.0.3 ARM64 build passes the large-GIF regression and image preparation
suite. Current image IDs and architecture-specific evidence are in `OUTBOUND-MEDIA.md`.
Existing SBOM reports refer to older image IDs and must be regenerated for codec images.

## Version command packaging (2026-09-16)

The staged runtime now includes the README, TypeScript configuration, formatting
configuration and Matrix SDK source metadata required by `version --json`.
The command no longer depends on the unshipped root implementation handoff.
`tests/entry.version.ts` passed on the host and against a fresh staged context
mounted read-only into the ARM64 Linux candidate, without networking or account
data. That context is `ba53320f131bcbe3b8a50ce985fe69c4df173b132f9bdf6a2311607a54510b5d`;
logs are `.local/version-package-{host,arm64}.log`. TypeScript checks passed.
This verifies the packaging inputs and command, not a rebuilt release image.

The version source manifest also includes native C/header files, patch files,
Dockerfiles and the shipped deployment scripts/units. Linux staging copies tracked
`native`/`deploy` files only; a locally populated deployment directory is not swept
into the image. The version command reads an explicit list of operator files and
does not traverse installation data. Host and staged ARM64 version checks verify
hashes for the native limiter, Node cleanup patch, Dockerfile and weekly timer.
Context `4fcfa11dc9dc6e35f0d0a6f02c575d2d3326288278a75a099d499d1156600b6c`
passed, with logs `.local/version-native-{host,arm64}.log`; TypeScript checks passed.
This expands source-file coverage, not the scanner's compiled dependency coverage.
