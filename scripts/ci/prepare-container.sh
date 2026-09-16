#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
arch="${1:?Usage: prepare-container.sh amd64|arm64}"
case "$arch:$(uname -m)" in amd64:x86_64|arm64:aarch64) ;; *) echo 'Use a native Linux runner for the requested architecture' >&2; exit 1;; esac
test ! -e .local/linux-ci-context

pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir native/runtime-dependencies install --frozen-lockfile --ignore-scripts
node scripts/entry.prepare-upstream.ts
desktop=.local/sources/threema-desktop
matrix=.local/sources/matrix-appservice-bridge
cp integrations/matrix/pnpm-lock.yaml "$matrix/pnpm-lock.yaml"
cp integrations/matrix/.npmrc "$matrix/.npmrc"
# CLI flag wins over runner env; typecheck imports yaml/undici/crypto-nodejs from this tree.
pnpm --dir "$matrix" install --frozen-lockfile --ignore-scripts --config.node-linker=hoisted
for required in \
    yaml/dist/index.js \
    undici/index.js \
    @matrix-org/matrix-sdk-crypto-nodejs/index.js \
    @vector-im/matrix-bot-sdk/lib/index.js
do
    test -e "$matrix/node_modules/$required"
done
(cd "$desktop" && pnpm install --frozen-lockfile --ignore-scripts --config.engine-strict=false)
node scripts/entry.prepare-matrix-native.ts
node scripts/entry.prepare-matrix-framework.ts
node scripts/entry.build-native.ts
node scripts/entry.prepare-codec.ts
node scripts/entry.audit-ffmpeg-cenc.ts
node --test tests/entry.ffmpeg-cenc-audit.ts
node scripts/entry.prepare-video-inspector.ts
node scripts/entry.build-status-proxy.ts

mkdir -p .local/node-cleanup-review
node --input-type=module <<'NODE'
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const pin = JSON.parse(readFileSync('docs/NODE-CLEANUP-BUILD.json'));
const bytes = execFileSync('curl', ['--fail', '--location', '--retry', '3', pin.archiveUrl], {maxBuffer: 256 * 1024 * 1024});
assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.archiveSha256);
writeFileSync('.local/node-cleanup-review/' + pin.archive, bytes);
NODE

node scripts/entry.stage-wasm.ts
docker buildx build --platform "linux/$arch" --target artifact \
  --cache-from "type=gha,scope=wasm-$arch" --cache-to "type=gha,mode=max,scope=wasm-$arch" \
  --output type=local,dest=.local/wasm-web .local/wasm-source-context
node scripts/entry.audit-wasm-build.ts .local/wasm-source-context .local/wasm-web > .local/wasm-web/build-coverage.json
wasm="$desktop/packages/libthreema-wasm/libs/libthreema/build/wasm/web"
mkdir -p "$wasm"
cp .local/wasm-web/libthreema* "$wasm/"
(cd "$desktop" && pnpm --config.engine-strict=false exec turbo run build \
  --filter=@threema/ts-utils --filter=@threema/vite-plugin-commonjs-externals \
  --filter=@threema/vite-plugin-subresource-integrity)
(cd "$desktop/apps/desktop" && VITE_MAKE=cli,cli,consumer,live \
  node node_modules/vite/bin/vite.js build -m production -c config/vite.headless-spike.config.ts)

pnpm run typecheck

node scripts/entry.stage-matrix-source.ts
docker buildx build --platform "linux/$arch" --target artifact \
  --cache-from "type=gha,scope=matrix-$arch" --cache-to "type=gha,mode=max,scope=matrix-$arch" \
  --output "type=local,dest=.local/matrix-native-build-$arch" .local/matrix-native-source-context
node scripts/entry.audit-matrix-build.ts .local/matrix-native-source-context \
  ".local/matrix-native-build-$arch" "$arch" > ".local/matrix-native-build-$arch/build-coverage.json"
node scripts/entry.stage-linux-native.ts .local/linux-ci-context "$arch"
