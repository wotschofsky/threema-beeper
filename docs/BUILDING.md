# Building and upstream compatibility probes

Build commands run from the repository root. Production code lives in `src/`, upstream
modifications in `integrations/`, container builders in `deploy/docker/`, and isolated probes
in `tests/probes/`. See [container automation](CONTAINER-CI.md) for the clean Linux build.

The probe notes below record individual compatibility experiments; they are not a current
feature checklist. See [deployment](LINUX-DEPLOYMENT.md) for running the bridge.

Run `node scripts/entry.prepare-upstream.ts` from the project root first. The pinned Desktop
checkout is now `.local/sources/threema-desktop`; project-owned headless files are retained in
`integrations/threema/overlay`.

## Pinned WASM dependency build

From the repository root, on the native Linux ARM64 Docker engine:

```sh
docker build --platform linux/arm64 --file deploy/docker/Dockerfile.wasm \
  --target artifact --output type=local,dest=.local/wasm-web .local/sources/threema-desktop
```

The Rust version comes from upstream `rust-toolchain.toml`; wasm-bindgen comes from upstream
`Cargo.lock`. The build invokes the unmodified upstream script and uses its locked Cargo dependency
graph. Rust's base image and Binaryen archives are digest/checksum-pinned; apt packages are not a
release-pinned supply chain. The upstream Rust build requires protoc. Binaryen 108 from Bookworm
fails on the emitted WASM, so the builder installs Binaryen 123. Building WASM does not prove native
SQLCipher, Matrix crypto persistence, linking, or Gate 0E as a whole.

## Node 24 dependency experiment

```sh
(cd .local/sources/threema-desktop && pnpm install \
  --frozen-lockfile --ignore-scripts --config.engine-strict=false)
```

The engine override is local to this experiment. It does not establish runtime compatibility or
change the upstream Node 22 requirement. Native dependencies and generated upstream artifacts still
need their documented build steps. Do not run `rebuild:electron` for the Node headless runtime:
Electron's ABI is different from Node's ABI.

Use an explicit Node 24 executable if your shell or elevated command selects a different version.
The remaining commands assume `node --version` reports Node 24.

```sh
node scripts/entry.build-native.ts
node tests/probes/entry.native-persistence-probe.ts
```

The build driver locates the already-installed upstream node-gyp dependency and uses the current
Node executable for compilation. It also emits the Argon2 declaration file omitted by the
script-disabled install. The persistence probe uses fresh temporary data, sends no network traffic,
and removes only its own temporary directory.

## Backend import probe

Build the upstream utility packages, then copy the container-built artifacts into the location
expected by the existing package exports:

```sh
(cd .local/sources/threema-desktop && pnpm --config.engine-strict=false exec turbo run build \
  --filter=@threema/ts-utils \
  --filter=@threema/vite-plugin-commonjs-externals \
  --filter=@threema/vite-plugin-subresource-integrity)
mkdir -p .local/sources/threema-desktop/packages/libthreema-wasm/libs/libthreema/build/wasm/web
cp -R .local/wasm-web/. .local/sources/threema-desktop/packages/libthreema-wasm/libs/libthreema/build/wasm/web/
```

From `.local/sources/threema-desktop/apps/desktop`, run:

```sh
VITE_MAKE=cli,cli,consumer,live node node_modules/vite/bin/vite.js build \
  -m production -c config/vite.headless-spike.config.ts
```

Then from the repository root:

```sh
node tests/probes/entry.run-headless-probe.ts
node .local/sources/threema-desktop/node_modules/typescript/bin/tsc --noEmit -p .local/sources/threema-desktop/apps/desktop/src/headless/tsconfig.json
node .local/sources/threema-desktop/node_modules/typescript/bin/tsc --noEmit -p .local/sources/threema-desktop/apps/desktop/config/tsconfig.json
```

The probe imports the real Backend class and WASM; it does not create a linked backend, start
network connections, accept credentials, or report the live gate passed.

## Matrix encryption reproduction

Prepare the pinned reference source in `.local/sources/matrix-appservice-bridge`. If it is absent:

```sh
git clone https://github.com/matrix-org/matrix-appservice-bridge.git .local/sources/matrix-appservice-bridge
git -C .local/sources/matrix-appservice-bridge checkout --detach fe923be791bd1d2ade17839629a99400893c8173
```

From the repository root, reproduce the recorded dependency resolution and compile it:

```sh
cp integrations/matrix/pnpm-lock.yaml .local/sources/matrix-appservice-bridge/pnpm-lock.yaml
cp integrations/matrix/.npmrc .local/sources/matrix-appservice-bridge/.npmrc
pnpm --dir .local/sources/matrix-appservice-bridge install --frozen-lockfile --ignore-scripts
node .local/sources/matrix-appservice-bridge/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js
node .local/sources/matrix-appservice-bridge/node_modules/typescript/bin/tsc \
  --project .local/sources/matrix-appservice-bridge/tsconfig.json
node tests/probes/entry.matrix-encryption-probe.ts
```

The native crypto binary uses upstream's v0.6.6 installer. See `MATRIX-CRYPTO-PINS.json` for release fingerprints; source-built artifacts
are verified separately during Linux packaging.

This probe binds only to loopback and uses synthetic credentials/payloads. It verifies that the
framework's proxy-oriented encrypted intent has no native crypto and forwards cleartext to the
configured proxy endpoint. The sync-scheduler callback is replaced with an observed no-op; room
membership and power checks are bypassed. Encryption state lookup and HTTP send use the real SDK.
Success means the handoff mismatch was reproduced, not that encryption or Beeper works.

```sh
node .local/sources/threema-desktop/node_modules/typescript/bin/tsc --noEmit -p tests/probes/tsconfig.json
```

## Live acceptance prerequisites

Pairing and live checks require a dedicated test identity. Use a separate bridge profile;
never point a probe at an existing daily Desktop profile.
Initial live checks can use a notes group and an isolated Beeper room, but delivery to another
person and group-member behavior remain separate acceptance requirements. Implement and verify
native encryption before connecting the current proxy-oriented configuration to any real account.

## Protected native Matrix store

From the project root, run `pnpm run probe:matrix-native` with Node 24. This offline probe verifies
real Megolm encryption/decryption, device identity persistence across close/reopen, and wrong
passphrase rejection in the pinned native library. It does not connect to a homeserver or test
sharing keys with a second device. Gate 0D remains pending.

## Protected native SDK integration

After installing Matrix dependencies, run from the project root:

```sh
pnpm run prepare:matrix-native
pnpm run probe:matrix-sdk
```

This applies the checked-in, fingerprint-verified SDK overlay and compiles its source. See
`../integrations/matrix/overlay/README.md` for the patch scope and licensing. The SDK probe intercepts only the
transport and uses synthetic responses; native encryption, encrypted SDK event generation and
protected storage are real. It is not an appservice or Beeper gate pass.

## Device exchange and transaction ordering

Run `pnpm run probe:matrix-devices` after preparing the native SDK overlay. Two separate SDK clients
with protected stores upload genuine device keys, claim genuine one-time keys, exchange encrypted
Olm key messages and send Megolm messages in both directions using an in-memory test transport.
Neither decryption keys nor plaintext room messages are inserted into the receiving client.

The test verifies that decryption fails before key delivery, succeeds when the key and room event
arrive in the same appservice-shaped transaction, and survives reopening both stores. It also checks
that unknown recipient devices are rejected and asynchronous event-handler failures propagate. The
transaction adapter only supports the crypto extension fields used by the pinned SDK and
already-open clients. HTTP authentication, durable transaction retries/deduplication, remaining
control events and the framework/Beeper connection are still outstanding.

## Persistent appservice login through the framework

```sh
pnpm run prepare:matrix-native
pnpm run prepare:matrix-framework
pnpm run probe:matrix-login
```

The SDK overlay fixes saving the returned user token, preserves the requested device identity and
allows retrying a failed initialization. The framework patch passes protected storage through to its
SDK appservice and forbids the legacy listener in native mode. The probe uses the real Bridge and
intent with synthetic network responses. It closes framework timers and crypto stores on each
simulated restart. `pnpm run test:inbox` also tests startup transaction recovery and orderly
shutdown.

## Node factories and profile initialization

After rebuilding the headless bundle with the current overlay, run:

```sh
pnpm run probe:headless-lifecycle
```

This invokes real backend initialization against an empty temporary profile, checks the typed
missing-identity result, runs upstream SQLCipher migrations and reopens that database. It also
verifies unsupported UI/call operations fail explicitly. The profile is synthetic and removed
afterward. See `docs/HEADLESS-NODE-ADAPTER.md` for remaining lifecycle and linking requirements.
