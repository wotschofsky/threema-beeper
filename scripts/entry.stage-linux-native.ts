import {writeContextIntegrity} from './linux-context-integrity.ts';
import {patchCidrSource} from './runtime-dependency-overrides.ts';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Stage exact installed sources and their dependency closure, never host native binaries.
const root = fileURLToPath(new URL('../', import.meta.url));
const nodePin = JSON.parse(readFileSync(join(root, 'docs/NODE-CLEANUP-BUILD.json'), 'utf8'));
assert.equal(nodePin.archive, 'node-v24.21.0.tar.xz');
const nodeArchive = readFileSync(join(root, '.local/node-cleanup-review', nodePin.archive));
assert.equal(createHash('sha256').update(nodeArchive).digest('hex'), nodePin.archiveSha256);
const nodePatch = readFileSync(join(root, 'native/node24/cleanup-hooks.patch'));
assert.equal(createHash('sha256').update(nodePatch).digest('hex'),
    nodePin.patches['native/node24/cleanup-hooks.patch']);
const videoInspector = JSON.parse(
    readFileSync(join(root, '.local/video-inspector/manifest.json'), 'utf8'),
);
assert.equal(videoInspector.mediabunnyVersion, '1.34.4');
assert.equal(
    createHash('sha256')
        .update(readFileSync(join(root, '.local/video-inspector/entry.mjs')))
        .digest('hex'),
    videoInspector.bundleSha256,
);
assert(Array.isArray(videoInspector.inputs) && videoInspector.inputs.length > 0);
for (const input of videoInspector.inputs) {
    assert(
        typeof input.path === 'string' &&
            relative(root, resolve(root, input.path)) === input.path &&
            !input.path.startsWith('..'),
    );
    assert.equal(
        createHash('sha256')
            .update(readFileSync(join(root, input.path)))
            .digest('hex'),
        input.sha256,
        'Video inspector bundle is stale; run prepare:video-inspector',
    );
}
const openh264Pin = JSON.parse(readFileSync(join(root, 'docs/OPENH264-PINS.json'), 'utf8'));
assert.equal(openh264Pin.archive, 'openh264-2.6.0.tar.gz');
const openh264Archive = readFileSync(join(root, '.local/codec-sources', openh264Pin.archive));
assert.equal(createHash('sha256').update(openh264Archive).digest('hex'), openh264Pin.sha256);
const opusPin = JSON.parse(readFileSync(join(root, 'docs/OPUS-PINS.json'), 'utf8'));
assert.equal(opusPin.archive, 'opus-1.6.1.tar.gz');
const opusArchive = readFileSync(join(root, '.local/codec-sources', opusPin.archive));
assert.equal(createHash('sha256').update(opusArchive).digest('hex'), opusPin.sha256);
const jpegPin = JSON.parse(readFileSync(join(root, 'docs/JPEG-PINS.json'), 'utf8'));
assert.equal(jpegPin.archive, 'libjpeg-turbo-3.2.0.tar.gz');
const jpegArchive = readFileSync(join(root, '.local/codec-sources', jpegPin.archive));
assert.equal(createHash('sha256').update(jpegArchive).digest('hex'), jpegPin.sha256);
const codecPin = JSON.parse(readFileSync(join(root, 'docs/FFMPEG-PINS.json'), 'utf8'));
assert.equal(codecPin.archive, 'ffmpeg-8.0.3.tar.xz');
const codecArchive = readFileSync(join(root, '.local/codec-sources', codecPin.archive));
const webpPin = JSON.parse(readFileSync(join(root, 'docs/WEBP-PINS.json'), 'utf8'));
assert.equal(webpPin.archive, 'libwebp-1.6.0.tar.gz');
const webpArchive = readFileSync(join(root, '.local/codec-sources', webpPin.archive));
assert.equal(createHash('sha256').update(webpArchive).digest('hex'), webpPin.sha256);
assert.equal(
    createHash('sha256').update(codecArchive).digest('hex'),
    codecPin.sha256,
    'FFmpeg source archive does not match its verified release pin',
);
const avifSources = ['AVIF', 'DAV1D', 'LCMS'].map((name) => {
    const pin = JSON.parse(readFileSync(join(root, 'docs', `${name}-PINS.json`), 'utf8'));
    assert.equal(
        pin.archive,
        name === 'AVIF'
            ? 'libavif-1.4.2.tar.gz'
            : name === 'LCMS'
              ? 'lcms2-2.19.tar.gz'
              : 'dav1d-1.5.4.tar.xz',
    );
    const archive = readFileSync(join(root, '.local/codec-sources', pin.archive));
    assert.equal(createHash('sha256').update(archive).digest('hex'), pin.sha256);
    return {pin, archive};
});
const freshArchitecture = process.argv[3];
assert(process.argv.length <= 4 && (freshArchitecture === undefined || ['arm64', 'amd64'].includes(freshArchitecture)),
    'Usage: node scripts/entry.stage-linux-native.ts [new-context] [arm64|amd64]');
const destination = resolve(process.argv[2] ?? join(root, '.local/linux-native-context'));
assert(!existsSync(destination), 'Use a fresh staging directory');
assert(destination.startsWith(join(root, '.local') + sep), 'Stage only inside .local');
const desktop = join(root, '.local/sources/threema-desktop/apps/desktop/package.json');
const seen = new Set<string>();
const packages: {path: string; name: string; version: string; packageJsonSha256: string}[] = [];

function locate(name: string, from: string): string | undefined {
    // Upgrade the Matrix closure without modifying the live development checkout.
    if (['js-yaml', 'ip-cidr'].includes(name) && from.startsWith(join(root, '.local/sources/matrix-appservice-bridge') + sep)) {
        const pinned = join(root, 'native/runtime-dependencies/node_modules', name, 'package.json');
        assert(existsSync(pinned), 'Run pnpm --dir native/runtime-dependencies install --frozen-lockfile --ignore-scripts');
        assert.equal(JSON.parse(readFileSync(pinned, 'utf8')).version, name === 'js-yaml' ? '4.3.2' : '4.0.2');
        return realpathSync(pinned);
    }
    const require = createRequire(from);
    for (const search of require.resolve.paths('__bridge_dependency_lookup__') ?? []) {
        const filename = join(search, name, 'package.json');
        if (existsSync(filename)) return realpathSync(filename);
    }
    return undefined;
}
function linkDependency(name: string, from: string, filename: string): void {
    const link = join(destination, relative(root, dirname(from)), 'node_modules', name);
    const target = join(destination, relative(root, dirname(filename)));
    if (link === target || existsSync(link)) return;
    mkdirSync(dirname(link), {recursive: true});
    symlinkSync(relative(dirname(link), target), link);
}

function stage(filename: string): void {
    if (seen.has(filename)) return;
    seen.add(filename);
    const source = dirname(filename);
    const path = relative(root, source);
    assert(!path.startsWith('..') && !path.startsWith('/'), 'Dependency outside workspace');
    const bytes = readFileSync(filename);
    const manifest = JSON.parse(bytes.toString('utf8'));
    cpSync(source, join(destination, path), {
        recursive: true,
        filter: (entry) => {
            const parts = relative(source, entry).split(sep);
            return (
                !parts.some(
                    (part) =>
                        ['node_modules', 'prebuilds', '.git', '.DS_Store'].includes(part) ||
                        (part === 'build' &&
                            ['better-sqlcipher', 'argon2'].includes(manifest.name)),
                ) && !entry.endsWith('.node')
            );
        },
    });
    if (manifest.name === 'ip-cidr') {
        assert.equal(manifest.version, '4.0.2');
        writeFileSync(join(destination, path, 'index.js'), patchCidrSource(readFileSync(join(source, 'index.js'), 'utf8')));
    }
    packages.push({
        path,
        name: manifest.name,
        version: manifest.version,
        packageJsonSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    for (const name of Object.keys({...manifest.dependencies, ...manifest.optionalDependencies})) {
        const dependency = locate(name, filename);
        if (!dependency && name in (manifest.optionalDependencies ?? {})) continue;
        assert(dependency, `Missing dependency ${name} of ${manifest.name}`);
        stage(dependency);
        linkDependency(name, filename, dependency);
    }
}
mkdirSync(destination, {recursive: true});
for (const name of ['better-sqlcipher', 'argon2', 'mediabunny', 'emojibase-data']) {
    const filename = locate(name, desktop);
    assert(filename);
    stage(filename);
    linkDependency(name, desktop, filename);
}
const matrixRoot = join(root, '.local/sources/matrix-appservice-bridge/package.json');
stage(matrixRoot);
const yaml = locate('yaml', matrixRoot);
assert(yaml);
stage(yaml);
linkDependency('yaml', matrixRoot, yaml);
const sdk = locate('@vector-im/matrix-bot-sdk', matrixRoot);
assert(sdk);
stage(sdk);
linkDependency('@vector-im/matrix-bot-sdk', matrixRoot, sdk);
const crypto = locate('@matrix-org/matrix-sdk-crypto-nodejs', matrixRoot);
assert(crypto);
stage(crypto);
linkDependency('@matrix-org/matrix-sdk-crypto-nodejs', matrixRoot, crypto);
const cryptoPins = JSON.parse(readFileSync(join(root, 'docs/MATRIX-CRYPTO-PINS.json'), 'utf8'));
assert.equal(JSON.parse(readFileSync(crypto, 'utf8')).version, cryptoPins.version);
const coverage = JSON.parse(readFileSync(join(root, 'docs/NATIVE-SOURCE-COVERAGE.json'), 'utf8'));
const matrixArtifacts = [];
for (const architecture of freshArchitecture ? [freshArchitecture] : ['arm64', 'amd64']) {
    const recorded = coverage.matrixNativeCrypto.observedBuilds[architecture];
    if (!freshArchitecture) assert(
        recorded?.buildParticipationObserved && recorded.compatibilityTestsPassed === 3,
        'Source-built Matrix addon has not passed compatibility checks',
    );
    const output = join(root, '.local', 'matrix-native-build-' + architecture);
    const reportBytes = readFileSync(join(output, 'build-coverage.json'));
    if (!freshArchitecture) assert.equal(
        createHash('sha256').update(reportBytes).digest('hex'),
        recorded.fullReport.sha256,
    );
    const report = JSON.parse(reportBytes.toString('utf8'));
    const audited = JSON.parse(
        execFileSync(
            process.execPath,
            [
                join(root, 'scripts/entry.audit-matrix-build.ts'),
                join(root, '.local/matrix-native-source-context'),
                output,
                architecture,
            ],
            {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024},
        ),
    );
    assert.deepEqual(audited, report, 'Source-built Matrix artifact evidence changed');
    assert.equal(report.sourceCommit, cryptoPins.sourceCommit);
    assert.equal(report.releaseVersion, cryptoPins.version);
    const name =
        'matrix-sdk-crypto.linux-' +
        (architecture === 'amd64' ? 'x64' : architecture) +
        '-gnu.node';
    assert.equal(report.nativeFilename, name);
    const bytes = readFileSync(join(output, name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), report.nativeSha256);
    writeFileSync(join(destination, relative(root, dirname(crypto)), name), bytes);
    matrixArtifacts.push({
        architecture,
        name,
        bytes: bytes.length,
        sha256: report.nativeSha256,
        sourceCommit: report.sourceCommit,
        inputSha256: report.inputSha256,
        buildReportSha256: createHash('sha256').update(reportBytes).digest('hex'),
        origin: 'local-source-build',
    });
}
writeFileSync(
    join(destination, 'matrix-native-artifacts.json'),
    JSON.stringify(matrixArtifacts, null, 2) + '\n',
);
const bbctlPins = JSON.parse(
    readFileSync(join(root, '.local/bin/bbctl-status/manifest.json'), 'utf8'),
);
assert.equal(bbctlPins.commit, '621b50c3c9e395eda28ebe522a1406fdef71c8c9');
assert.equal(bbctlPins.dependencyPatchSha256,
    createHash('sha256').update(readFileSync(join(root, 'native/bbctl/dependencies.patch'))).digest('hex'));
assert.deepEqual(bbctlPins.dependencyPins,
    JSON.parse(readFileSync(join(root, 'native/bbctl/dependencies.json'), 'utf8')));
assert.equal(
    bbctlPins.patchSha256,
    createHash('sha256')
        .update(readFileSync(join(root, 'native/bbctl/account-status.patch')))
        .digest('hex'),
);
writeFileSync(
    join(destination, 'status-proxy-manifest.json'),
    JSON.stringify(bbctlPins, null, 2) + '\n',
);
for (const architecture of ['arm64', 'amd64']) {
    const name = `bbctl-linux-${architecture}`;
    const asset = bbctlPins.assets.find((entry: {name: string}) => entry.name === name);
    assert(asset, 'Missing bbctl architecture pin');
    const bytes = readFileSync(join(root, '.local/bin/bbctl-status', name));
    assert.equal(bytes.length, asset.size, 'bbctl binary size mismatch');
    assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        asset.sha256,
        'bbctl binary checksum mismatch',
    );
    const target = join(destination, '.artifacts/bbctl', name);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, bytes, {mode: 0o555});
}
const tar = locate('tar', join(root, 'package.json'));
assert(tar);
assert.equal(JSON.parse(readFileSync(tar, 'utf8')).version, '7.5.21', 'Install pinned root dependencies with pnpm install --frozen-lockfile');
stage(tar);
linkDependency('tar', join(root, 'package.json'), tar);
const runtimePackages = new Set(packages.map((entry) => entry.path));
const rebuild = locate('@electron/rebuild', desktop);
assert(rebuild);
const gyp = locate('node-gyp', rebuild);
assert(gyp);
stage(gyp);
const buildOnlyPackagePaths = packages.filter((entry) => !runtimePackages.has(entry.path)).map((entry) => entry.path);
for (const path of [
    'tests/entry.linux-config.ts',
    'tests/entry.unsupported-content.ts',
    'tests/entry.media-replies.ts',
    'tests/entry.media-crash.ts',
    'tests/entry.media-reply-crash.ts',
    'tests/entry.status-crash.ts',
    'tests/entry.outbox-crash.ts',
    'tests/entry.recovery-controls.ts',
    'tests/entry.send-failure-notices.ts',
    'package.json',
    'pnpm-lock.yaml',
    'native/media-limits.c',
    'native/build-openh264.sh',
    'docs/OPENH264-PINS.json',
    'tests/entry.video-encoder.ts',
    'tests/entry.video-source.ts',
    'tests/entry.video-inspector.ts',
    'tests/entry.video-preparation.ts',
    'tests/entry.video-fallback.ts',
    'tests/entry.video-staging.ts',
    'tests/entry.video-download.ts',
    'tests/entry.video-worker.ts',
    'tests/entry.video-geometry.ts',
    'scripts/entry.video-playback-probe.ts',
    'tests/fixtures/video-session-worker.ts',
    'tests/entry.backend-shutdown.ts',
    'tests/entry.profile-runtime.ts',
    'tests/entry.profile-sync.ts',
    'tests/entry.retained-confirmation.ts',
    'tests/entry.media-ingress.ts',
    'tests/entry.media-runtime.ts',
    'tests/entry.video-thumbnail.ts',
    'tests/fixtures/video-thumbnails.json',
    'tests/entry.outbound-attachment.ts',
    '.local/video-inspector/entry.mjs',
    '.local/video-inspector/manifest.json',
    'tests/fixtures/video-timelines.json',
    'native/build-opus.sh',
    'docs/OPUS-PINS.json',
    'native/build-jpeg.sh',
    'native/jpeg-encode.c',
    'native/jpeg-srgb-profile.h',
    'docs/JPEG-PINS.json',
    'tests/entry.jpeg-encode.ts',
    'tests/fixtures/renderer-jpeg.json',
    'tests/fixtures/renderer-resize.json',
    'native/build-ffmpeg.sh',
    'tests/entry.ffmpeg-security.ts',
    'native/build-webp.sh',
    'native/build-avif.sh',
    'native/avif-first-frame.c',
    'docs/AVIF-PINS.json',
    'docs/DAV1D-PINS.json',
    'docs/LCMS-PINS.json',
    'tests/entry.avif-first-frame.ts',
    'tests/entry.avif-image.ts',
    'tests/fixtures/avif-grid.ts',
    'tests/fixtures/renderer-avif.json',
    'native/webp-first-frame.c',
    'docs/WEBP-PINS.json',
    'tests/entry.webp-first-frame.ts',
    'docs/FFMPEG-PINS.json',
    'tests/entry.codec-process.ts',
    'tests/entry.image-codec.ts',
    'tests/entry.audio-duration.ts',
    'tests/entry.audio-preparation.ts',
    'tests/entry.audio-staging.ts',
    'tests/entry.audio-timeline.ts',
    'tests/entry.audio-mixed-tracks.ts',
    'tests/entry.opus-preparation.ts',
    'tests/entry.audio-fallback.ts',
    'tests/entry.audio-fallback-outbox.ts',
    'tests/entry.video-outbox.ts',
    'tests/entry.prepared-video-send.ts',
    'tests/entry.prepared-video-controller.ts',
    'tests/fixtures/audio-timelines.json',
    'tests/entry.audio-outbox.ts',
    'tests/entry.image-preparation.ts',
    'scripts/linux-context-integrity.ts',
    'scripts/entry.verify-linux-context.ts',
    'scripts/entry.prepare-linux-artifacts.ts',
    'tests/probes/entry.native-persistence-probe.ts',
    'tests/probes/entry.matrix-native-persistence-probe.ts',
    'docs/MATRIX-CRYPTO-PINS.json',
    'docs/BBCTL-PINS.json',
    'docs/SOURCE-PINS.json',
    'LICENSE.txt',
    'README.md',
    'tsconfig.json',
    '.prettierrc.yml',
    'integrations/matrix/overlay/source.json',
    'tests/entry.version.ts',
    'integrations/threema/overlay/src/headless/node-typing-request.ts',
    'tests/entry.upstream-monitor.ts',
    'tests/entry.security-scan.ts',
    'tests/entry.security-notices.ts',
    'tests/entry.reconnect-policy.ts',
    'tests/entry.reconnect-notices.ts',
    'tests/entry.connection-issue.ts',
    'tests/entry.connection-issue-notices.ts',
    'tests/entry.disk-notices.ts',
    'tests/entry.security-database.ts',
    'tests/entry.security-host-script.ts',
    'tests/entry.upstream-monitor-restart.ts',
    'tests/entry.upstream-notices.ts',
    'tests/entry.management-room.ts',
    'tests/entry.management-room-policy.ts',
    'tests/entry.management-worker.ts',
    'tests/entry.management-actions.ts',
    'tests/probes/entry.matrix-device-exchange-probe.ts',
    'tests/probes/entry.headless-lifecycle-probe.ts',
    'tests/entry.backend-controller.ts',
    'tests/entry.mutation-command.ts',
    'tests/entry.typing-command.ts',
    'tests/entry.typing-runtime.ts',
    'tests/entry.connection-subscription.ts',
    'tests/entry.incoming-typing.ts',
    'tests/entry.mutation-target.ts',
    'tests/entry.mutation-content.ts',
    'tests/entry.mutation-ingress.ts',
    'tests/entry.original-event.ts',
    'tests/entry.mutation-journal.ts',
    'tests/entry.mutation-runtime.ts',
    'tests/entry.mutation-worker.ts',
    'tests/entry.owner-encryption.ts',
    'tests/entry.owner-text-edit.ts',
    'tests/entry.owner-media-content.ts',
    'tests/entry.journal-sink.ts',
    'tests/entry.encrypted-sender.ts',
    'tests/entry.message-delivery.ts',
    'tests/fixtures/mutation-session-worker.ts',
    'scripts/entry.test-files.ts',
    'tests/entry.test-files.ts',
    'tests/entry.mutation-recovery.ts',
    'tests/entry.outbound-echo.ts',
    'tests/entry.local-echo-confirmation.ts',
    'tests/entry.image-mutation.ts',
    'tests/entry.backup-store-drill.ts',
    'tests/entry.backup-retention.ts',
    'tests/entry.backup-notices.ts',
    'tests/entry.yaml-runtime.ts',
    'tests/entry.cidr-runtime.ts',
    'scripts/runtime-dependency-overrides.ts',
    'tests/entry.heartbeat-https.ts',
    'tests/entry.heartbeat.ts',
    'tests/entry.history-validation.ts',
    'tests/entry.history-window.ts',
    'tests/entry.history.ts',
    'tests/entry.proxy.ts',
    'tests/entry.snapshot-page.ts',
    'tests/entry.tar-long-path.ts',
    'tests/entry.transaction-server.ts',
    'tests/entry.validator-fuzz.ts',
    'integrations/threema/overlay/src/headless/node-history-window.ts',
    'integrations/threema/overlay/src/headless/node-connection-issue.ts',
    'tests/entry.database-doctor.ts',
    'tests/entry.unsupported-notices.ts',
    'tests/entry.source-order.ts',
    'tests/entry.mutation-dispatcher.ts',
    'tests/entry.service-start.ts',
    'tests/entry.service-resources.ts',
    'tests/entry.matrix-session.ts',
    'tests/entry.owner-room-join.ts',
    'tests/entry.watch-lifetime.ts',
    'tests/entry.portals.ts',
    'tests/entry.portal-migration-rollback.ts',
    'tests/entry.node-send.ts',
    'tests/entry.current-members.ts',
    'tests/entry.local-model-handle.ts',
    'config.example.yaml',
    'src/matrix/appservice-storage.ts',
    'src/matrix/protected-storage.ts',
    'src/matrix/native-transaction.ts',
    'src/matrix/encrypted-sender.ts',
    'src/matrix/portal-store.ts',
    'src/matrix/transaction-inbox.ts',
    'src/matrix/transaction-worker.ts',
    'deploy/docker/Dockerfile.native',
]) {
    mkdirSync(dirname(join(destination, path)), {recursive: true});
    cpSync(join(root, path), join(destination, path));
}
// This probe consumes an existing JS bundle and WASM artifact. It does not claim
// that the complete upstream toolchain has been reproduced in this Linux image.
cpSync(join(root, 'src'), join(destination, 'src'), {recursive: true});
// Copy tracked source only: a local deployment directory may also contain credentials.
const operatorSources = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'native', 'deploy'],
    {encoding: 'utf8'}).split('\0').filter(Boolean);
for (const path of operatorSources) {
    mkdirSync(dirname(join(destination, path)), {recursive: true});
    cpSync(join(root, path), join(destination, path));
}
const artifacts = [
    {
        source: '.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
        target: '.artifacts/headless/entry.probe.cjs',
    },
    {source: '.local/wasm-web/libthreema_bg.wasm', target: '.local/wasm-web/libthreema_bg.wasm'},
].map(({source, target}) => {
    const bytes = readFileSync(join(root, source));
    mkdirSync(dirname(join(destination, target)), {recursive: true});
    writeFileSync(join(destination, target), bytes);
    return {
        source,
        target,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
});
writeFileSync(
    join(destination, 'headless-artifacts.json'),
    JSON.stringify(artifacts, null, 2) + '\n',
);
writeFileSync(
    join(destination, 'native-build.json'),
    JSON.stringify(
        {
            nodeGyp: relative(root, join(dirname(gyp), 'bin/node-gyp.js')),
            buildOnlyPackagePaths,
            packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
        },
        null,
        2,
    ) + '\n',
);
mkdirSync(join(destination, '.artifacts/avif'), {recursive: true});
mkdirSync(join(destination, '.artifacts/jpeg'), {recursive: true});
writeFileSync(join(destination, '.artifacts/jpeg', jpegPin.archive), jpegArchive);
for (const {pin, archive} of avifSources)
    writeFileSync(join(destination, '.artifacts/avif', pin.archive), archive);
mkdirSync(join(destination, '.artifacts/ffmpeg'), {recursive: true});
mkdirSync(join(destination, '.artifacts/openh264'), {recursive: true});
writeFileSync(join(destination, '.artifacts/openh264', openh264Pin.archive), openh264Archive);
mkdirSync(join(destination, '.artifacts/opus'), {recursive: true});
writeFileSync(join(destination, '.artifacts/opus', opusPin.archive), opusArchive);
mkdirSync(join(destination, '.artifacts/webp'), {recursive: true});
writeFileSync(join(destination, '.artifacts/webp', webpPin.archive), webpArchive);
writeFileSync(join(destination, '.artifacts/ffmpeg', codecPin.archive), codecArchive);
// Root names match the isolated runtime experiment so verified build layers can be reused.
writeFileSync(join(destination, nodePin.archive), nodeArchive);
writeFileSync(join(destination, 'cleanup-hooks.patch'), nodePatch);
cpSync(join(root, 'docs/NODE-CLEANUP-BUILD.json'), join(destination, 'docs/NODE-CLEANUP-BUILD.json'));
writeFileSync(join(destination, '.dockerignore'), '**/.DS_Store\n');
console.log(`Context SHA-256: ${writeContextIntegrity(destination)}`);
console.log(`Staged ${packages.length} installed packages in ${destination}`);
