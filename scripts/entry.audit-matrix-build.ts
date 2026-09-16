import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {verifyContextIntegrity} from './linux-context-integrity.ts';

const [context, output, architecture] = process.argv.slice(2);
assert(
    context && output && ['arm64', 'amd64'].includes(architecture!) && process.argv.length === 5,
    'Usage: node scripts/entry.audit-matrix-build.ts <context> <output> <arm64|amd64>',
);
const inputSha256 = verifyContextIntegrity(context);
const pin = JSON.parse(readFileSync(join(context, 'source-pin.json'), 'utf8'));
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
);
const metadata = JSON.parse(read('cargo-metadata.json').toString('utf8'));
assert.equal(metadata.version, 1);
const packages = new Map<string, any>(metadata.packages.map((pkg: {id: string}) => [pkg.id, pkg]));
const target = architecture === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
const units = messages
    .filter((message) => message.reason === 'compiler-artifact')
    .map((artifact) => {
        const pkg = packages.get(artifact.package_id);
        assert(pkg, 'Compiler package missing from resolved metadata');
        assert(Array.isArray(artifact.filenames) && artifact.filenames.length > 0);
        const native = artifact.filenames.every((path: string) =>
            path.startsWith(`/source/target/${target}/release/`),
        );
        assert(
            native ||
                artifact.filenames.every((path: string) =>
                    path.startsWith('/source/target/release/'),
                ),
        );
        return {
            packageId: pkg.id,
            name: pkg.name,
            version: pkg.version,
            source: pkg.source,
            license: pkg.license,
            role: native ? 'native-target' : 'host-build',
            targetKind: artifact.target.kind,
            features: artifact.features,
            profile: artifact.profile,
            filenames: artifact.filenames,
            cached: artifact.fresh,
        };
    });
assert(
    units.some(
        (unit) =>
            unit.name === 'matrix-sdk-crypto-nodejs' &&
            unit.role === 'native-target' &&
            unit.features.includes('bundled-sqlite') &&
            unit.targetKind.includes('cdylib'),
    ),
);
const filename = `matrix-sdk-crypto.linux-${architecture === 'amd64' ? 'x64' : 'arm64'}-gnu.node`;
const nativeSha256 = hash(read(filename));
const hashes = new Map(
    read('build-hashes.txt')
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => {
            const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
            assert(match);
            return [match[2]!, match[1]!];
        }),
);
assert.equal(hashes.get(`/artifacts/${filename}`), nativeSha256);
assert.equal(hashes.get('Cargo.lock'), hash(readFileSync(join(context, 'source/Cargo.lock'))));
const release = pin.assets.find((asset: {name: string}) => asset.name === filename);
assert(release, 'Missing release comparison pin');
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
            sourceCommit: pin.sourceCommit,
            releaseVersion: pin.version,
            inputSha256,
            target,
            nativeFilename: filename,
            nativeSha256,
            publishedReleaseSha256: release.sha256,
            matchesPublishedRelease: nativeSha256 === release.sha256,
            rustc: read('rustc-version.txt').toString('utf8'),
            cargo: read('cargo-version.txt').toString('utf8').trim(),
            observedCompilerUnits: units.length,
            observedPackages: new Set(units.map((unit) => unit.packageId)).size,
            nativeTargetPackages: new Set(
                units.filter((unit) => unit.role === 'native-target').map((unit) => unit.packageId),
            ).size,
            hostBuildPackages: new Set(
                units.filter((unit) => unit.role === 'host-build').map((unit) => unit.packageId),
            ).size,
            units,
            evidenceFiles: evidenceFiles.map((filename) => ({
                filename,
                sha256: hash(read(filename)),
            })),
            scope: 'Locally compiled pinned Rust crate using direct locked Cargo build and stripping. Requires Node compatibility tests; not an attestation of upstream release binary inputs.',
        },
        null,
        2,
    ),
);
