import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, '.local/sbom/matrix-native-source'));
assert(output.startsWith(join(root, '.local/sbom') + sep));
assert(!existsSync(output), 'Use a fresh source SBOM directory');
const pins = JSON.parse(readFileSync(join(root, 'docs/MATRIX-CRYPTO-PINS.json'), 'utf8'));
assert(/^[0-9a-f]{40}$/u.test(pins.sourceCommit));
const repository = join(root, '.local/sources/matrix-rust-sdk-crypto-nodejs');
const git = (...args: string[]): Buffer =>
    execFileSync('git', ['-C', repository, ...args], {maxBuffer: 16 * 1024 * 1024});
assert.equal(
    git('rev-parse', `${pins.sourceTag}^{commit}`).toString('utf8').trim(),
    pins.sourceCommit,
);
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const toolPins = JSON.parse(readFileSync(join(root, 'docs/SBOM-TOOL-PINS.json'), 'utf8'));
const tool = join(root, '.local/bin', `syft-${toolPins.version}`, 'syft');
assert.equal(hash(readFileSync(tool)), toolPins.executableSha256);
const source = join(output, 'source');
mkdirSync(source, {recursive: true});
// The separate xtask lockfile describes repository tooling, not the native library.
const inputs = [
    'Cargo.toml',
    'Cargo.lock',
    'LICENSE',
    'package.json',
    '.github/workflows/release.yml',
].map((path) => {
    const bytes = git('show', `${pins.sourceCommit}:${path}`);
    mkdirSync(dirname(join(source, path)), {recursive: true});
    writeFileSync(join(source, path), bytes, {flag: 'wx'});
    return {repositoryPath: path, bytes: bytes.length, sha256: hash(bytes)};
});
assert.equal(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version, pins.version);
const lock = readFileSync(join(source, 'Cargo.lock'), 'utf8');
const gitSources = [
    ...new Set([...lock.matchAll(/^source = "(git\+[^"\n]+)"$/gmu)].map((match) => match[1])),
].sort();
assert(gitSources.some((source) => source?.includes('matrix-org/matrix-rust-sdk#')));
const workflow = readFileSync(join(source, '.github/workflows/release.yml'), 'utf8');
const toolchain = /RUST_TOOLCHAIN_VERSION: '([^']+)'/u.exec(workflow)?.[1];
assert(toolchain, 'Release Rust toolchain not found');
const nativeBinaries = pins.assets.map((asset: {name: string; size: number; sha256: string}) => {
    const bytes = readFileSync(
        join(root, '.local/bin', `matrix-crypto-v${pins.version}`, asset.name),
    );
    assert.equal(bytes.length, asset.size);
    assert.equal(hash(bytes), asset.sha256);
    return {name: asset.name, bytes: bytes.length, sha256: asset.sha256};
});
execFileSync(
    tool,
    [
        'scan',
        `dir:${source}`,
        '--override-default-catalogers',
        'rust-cargo-lock-cataloger',
        '--source-name',
        'matrix-native-crypto-source',
        '--source-version',
        pins.sourceCommit,
        '-o',
        `cyclonedx-json=${join(output, 'matrix-native.cdx.json')}`,
        '-o',
        `spdx-json=${join(output, 'matrix-native.spdx.json')}`,
        '-o',
        `syft-json=${join(output, 'matrix-native.syft.json')}`,
    ],
    {env: {...process.env, SYFT_CHECK_FOR_APP_UPDATE: 'false'}, timeout: 120000, stdio: 'inherit'},
);
const scan = JSON.parse(readFileSync(join(output, 'matrix-native.syft.json'), 'utf8'));
assert(scan.artifacts.some((entry: {name: string}) => entry.name === 'matrix-sdk-crypto'));
const outputs = ['cdx', 'spdx', 'syft'].map((format) => {
    const filename = `matrix-native.${format}.json`;
    const bytes = readFileSync(join(output, filename));
    return {filename, bytes: bytes.length, sha256: hash(bytes)};
});
writeFileSync(
    join(output, 'coverage.json'),
    JSON.stringify(
        {
            schemaVersion: 1,
            sourceRepository: pins.sourceRepository,
            sourceCommit: pins.sourceCommit,
            sourceTag: pins.sourceTag,
            releaseVersion: pins.version,
            releaseToolchain: toolchain,
            inputs,
            gitSources,
            nativeBinaries,
            scanner: {version: toolPins.version, sha256: toolPins.executableSha256},
            outputs,
            detectedPackages: scan.artifacts.length,
            compiledDependencySetProven: false,
            scope: 'Tagged native-library Cargo.lock inventory; not proof that published binaries were built from this exact resolved graph. Separate xtask tooling is excluded.',
        },
        null,
        2,
    ) + '\n',
    {flag: 'wx'},
);
console.log(`Generated ${scan.artifacts.length} Matrix Rust dependency entries`);
