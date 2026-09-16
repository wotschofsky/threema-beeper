import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {verifyContextIntegrity} from './linux-context-integrity.ts';

const [context, output] = process.argv.slice(2);
assert(
    context && output && process.argv.length === 4,
    'Usage: node scripts/entry.audit-wasm-build.ts <source-context> <build-output>',
);
const inputSha256 = verifyContextIntegrity(context);
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const read = (filename: string): Buffer => readFileSync(join(output, filename));
const messages = read('cargo-build.jsonl')
    .toString('utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
assert.deepEqual(
    messages.filter((message) => message.reason === 'build-finished'),
    [{reason: 'build-finished', success: true}],
    'Cargo build did not finish successfully',
);
const metadata = JSON.parse(read('cargo-metadata.json').toString('utf8'));
assert.equal(metadata.version, 1);
const packages = new Map<string, any>(metadata.packages.map((pkg: {id: string}) => [pkg.id, pkg]));
const artifacts = messages.filter((message) => message.reason === 'compiler-artifact');
assert(artifacts.length > 0);
// The JSON replay follows upstream WASM optimization. If it recompiles anything,
// the optimized binary must be regenerated before it can be tied to these records.
assert(
    artifacts.every((artifact) => artifact.fresh === true),
    'Cargo replay rebuilt units after WASM optimization',
);
const units = artifacts.map((artifact) => {
    const pkg = packages.get(artifact.package_id);
    assert(pkg, 'Artifact package missing from resolved metadata');
    assert(Array.isArray(artifact.filenames) && artifact.filenames.length > 0);
    const target = artifact.filenames.every((path: string) =>
        path.startsWith('/source/target/wasm32-unknown-unknown/'),
    );
    assert(
        target ||
            artifact.filenames.every((path: string) => path.startsWith('/source/target/release/')),
        'Artifact outside the expected target directories',
    );
    return {
        packageId: pkg.id,
        name: pkg.name,
        version: pkg.version,
        source: pkg.source,
        license: pkg.license,
        role: target ? 'wasm-target' : 'host-build',
        targetKind: artifact.target.kind,
        features: artifact.features,
        profile: artifact.profile,
        filenames: artifact.filenames,
    };
});
assert(
    units.some(
        (unit) =>
            unit.name === 'libthreema' &&
            unit.role === 'wasm-target' &&
            unit.features.includes('wasm'),
    ),
);
const hashes = new Map(
    read('build-hashes.txt')
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => {
            const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
            assert(match, 'Invalid build hash record');
            return [match[2]!, match[1]!];
        }),
);
const wasmSha256 = hash(read('libthreema_bg.wasm'));
assert.equal(hashes.get('build/wasm/web/libthreema_bg.wasm'), wasmSha256);
assert.equal(
    hashes.get('Cargo.lock'),
    hash(readFileSync(join(context, 'packages/libthreema-wasm/libs/libthreema/Cargo.lock'))),
);
const evidenceFiles = [
    'cargo-build.jsonl',
    'cargo-metadata.json',
    'build-hashes.txt',
    'rustc-version.txt',
    'cargo-version.txt',
];
console.log(
    JSON.stringify(
        {
            schemaVersion: 1,
            source: JSON.parse(readFileSync(join(context, 'source-pin.json'), 'utf8')),
            inputSha256,
            wasmSha256,
            rawWasmSha256: hashes.get('target/wasm32-unknown-unknown/release/libthreema.wasm'),
            rustc: read('rustc-version.txt').toString('utf8'),
            cargo: read('cargo-version.txt').toString('utf8').trim(),
            observedCompilerUnits: units.length,
            observedPackages: new Set(units.map((unit) => unit.packageId)).size,
            wasmTargetPackages: new Set(
                units.filter((unit) => unit.role === 'wasm-target').map((unit) => unit.packageId),
            ).size,
            hostBuildPackages: new Set(
                units.filter((unit) => unit.role === 'host-build').map((unit) => unit.packageId),
            ).size,
            units,
            evidenceFiles: evidenceFiles.map((filename) => ({
                filename,
                sha256: hash(read(filename)),
            })),
            scope: 'Observed Cargo build participation and features, including cached units; not proof that every crate contributes retained bytes after linking/optimization, or independent signed build provenance.',
        },
        null,
        2,
    ),
);
