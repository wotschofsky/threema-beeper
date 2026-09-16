import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [directory, architecture, candidateObservations] = process.argv.slice(2);
assert(
    directory && ['arm64', 'amd64'].includes(architecture!) && [4, 5].includes(process.argv.length),
    'Usage: node scripts/entry.audit-image-sbom.ts <reports-directory> <arm64|amd64> [observations-json]',
);
const observations = JSON.parse(
    readFileSync(candidateObservations ? resolve(candidateObservations) : join(root, 'docs/LINUX-IMAGE-OBSERVATIONS.json'), 'utf8'),
);
const image = observations.images.find(
    (item: {architecture: string}) => item.architecture === architecture,
);
assert(image, 'Missing recorded image observation');
const files = ['syft', 'cdx', 'spdx'].map((format) => {
    const path = join(directory, `${architecture}.${format}.json`);
    const bytes = readFileSync(path);
    return {
        format,
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        data: JSON.parse(bytes.toString('utf8')),
    };
});
const scan = files[0]!.data;
assert.equal(scan.source.metadata.imageID, image.imageId, 'SBOM describes a different image');
assert.equal(files[1]!.data.bomFormat, 'CycloneDX');
assert.equal(files[2]!.data.spdxVersion, 'SPDX-2.3');
const packages = scan.artifacts as {
    name: string;
    version: string;
    type: string;
    locations: {path: string}[];
}[];
const counts: Record<string, number> = {};
for (const item of packages) counts[item.type] = (counts[item.type] ?? 0) + 1;
for (const name of [
    'better-sqlcipher',
    'argon2',
    '@matrix-org/matrix-sdk-crypto-nodejs',
    'github.com/beeper/bridge-manager',
    'tini',
    'ca-certificates',
]) {
    assert(
        packages.some((item) => item.name === name),
        `Required component not detected: ${name}`,
    );
}
const intermediates = packages
    .filter((item) =>
        item.locations.some((location) => location.path.includes('/build/Release/obj/')),
    )
    .map((item) => ({
        name: item.name,
        version: item.version,
        locations: item.locations.map((location) => location.path),
    }));
console.log(
    JSON.stringify(
        {
            schemaVersion: 1,
            architecture,
            imageId: image.imageId,
            inputSha256: image.inputSha256,
            scanner: {name: scan.descriptor.name, version: scan.descriptor.version},
            detectedPackages: packages.length,
            counts,
            outputs: files.map(({data: _data, ...file}) => file),
            detectedBuildIntermediates: intermediates,
            cargoMetadataDetected: (counts['rust-crate'] ?? 0) > 0,
            releaseReady: false,
            limitations: [
                'Image inventory does not establish complete compiled Rust/WASM dependency coverage.',
                'Native crypto and WASM require build-linked source dependency inventories.',
                'Experimental images still contain source files and JavaScript build tooling.',
                'SBOM generation is not vulnerability scanning or license compliance approval.',
            ],
        },
        null,
        2,
    ),
);
