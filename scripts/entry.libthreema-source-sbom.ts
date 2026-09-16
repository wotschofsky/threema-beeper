import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, '.local/sbom/libthreema-source'));
assert(output.startsWith(join(root, '.local/sbom') + sep));
assert(!existsSync(output), 'Use a fresh source SBOM output directory');
const pins = JSON.parse(readFileSync(join(root, 'docs/SOURCE-PINS.json'), 'utf8'));
const pin = pins.repositories.find((item: {name: string}) => item.name === 'threema-desktop');
assert(pin && /^[0-9a-f]{40}$/u.test(pin.commit));
const repository = join(root, '.local/sources/threema-desktop');
const prefix = 'packages/libthreema-wasm/libs/libthreema/';
const git = (...args: string[]): Buffer =>
    execFileSync('git', ['-C', repository, ...args], {maxBuffer: 16 * 1024 * 1024});
const paths = git('ls-tree', '-r', '--name-only', pin.commit, '--', prefix)
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(
        (path) =>
            ['Cargo.toml', 'Cargo.lock'].includes(basename(path)) ||
            /\/(LICENSE[^/]*|NOTICE[^/]*)$/u.test(path) ||
            path === prefix + 'tools/build-wasm.sh',
    );
assert(paths.includes(prefix + 'Cargo.lock') && paths.includes(prefix + 'lib/Cargo.toml'));
const toolPins = JSON.parse(readFileSync(join(root, 'docs/SBOM-TOOL-PINS.json'), 'utf8'));
const tool = join(root, '.local/bin', `syft-${toolPins.version}`, 'syft');
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(readFileSync(tool)), toolPins.executableSha256, 'SBOM tool checksum mismatch');
const source = join(output, 'source');
mkdirSync(source, {recursive: true});
const inputs = paths.map((path) => {
    const bytes = git('show', `${pin.commit}:${path}`);
    const target = join(source, path.slice(prefix.length));
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, bytes, {flag: 'wx'});
    return {repositoryPath: path, bytes: bytes.length, sha256: hash(bytes)};
});
const buildLines = readFileSync(join(source, 'tools/build-wasm.sh'), 'utf8').split('\n');
const cargoStart = buildLines.findIndex((line) => line.startsWith('cargo build'));
assert(cargoStart >= 0);
const cargoEnd = buildLines.findIndex((line, index) => index > cargoStart && line.trim() === '');
assert(cargoEnd > cargoStart);
const buildCommand = buildLines
    .slice(cargoStart, cargoEnd)
    .map((line) => line.replace(/\\$/u, '').trim())
    .join(' ');
assert.equal(
    buildCommand,
    'cargo build --locked -F wasm -p libthreema --target wasm32-unknown-unknown --release',
    'Upstream build selection changed; review the source inventory scope',
);
execFileSync(
    tool,
    [
        'scan',
        `dir:${source}`,
        '--override-default-catalogers',
        'rust-cargo-lock-cataloger',
        '--source-name',
        'libthreema-workspace-source',
        '--source-version',
        pin.commit,
        '-o',
        `cyclonedx-json=${join(output, 'libthreema.cdx.json')}`,
        '-o',
        `spdx-json=${join(output, 'libthreema.spdx.json')}`,
        '-o',
        `syft-json=${join(output, 'libthreema.syft.json')}`,
    ],
    {env: {...process.env, SYFT_CHECK_FOR_APP_UPDATE: 'false'}, timeout: 120000, stdio: 'inherit'},
);
const scan = JSON.parse(readFileSync(join(output, 'libthreema.syft.json'), 'utf8'));
assert(scan.artifacts.length > 0);
assert(scan.artifacts.some((item: {name: string}) => item.name === 'wasm-bindgen'));
const outputs = ['cdx', 'spdx', 'syft'].map((format) => {
    const filename = `libthreema.${format}.json`;
    const bytes = readFileSync(join(output, filename));
    return {filename, bytes: bytes.length, sha256: hash(bytes)};
});
const report = {
    schemaVersion: 1,
    source: pin,
    inputs,
    scanner: {version: toolPins.version, sha256: toolPins.executableSha256},
    outputs,
    detectedPackages: scan.artifacts.length,
    buildSelection: {
        package: 'libthreema',
        feature: 'wasm',
        target: 'wasm32-unknown-unknown',
        profile: 'release',
        locked: true,
    },
    observedWasmSha256: hash(readFileSync(join(root, '.local/wasm-web/libthreema_bg.wasm'))),
    compiledDependencySetProven: false,
    scope: 'Pinned workspace lockfile inventory includes dependencies for other features, targets and tools; it is not the selected compiled WASM dependency graph.',
};
writeFileSync(join(output, 'coverage.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(
    `Generated ${scan.artifacts.length} source dependency entries in ${relative(root, output)}`,
);
