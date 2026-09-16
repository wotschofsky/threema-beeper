import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';

const [cacheArgument, outputArgument] = process.argv.slice(2);
assert(process.argv.length === 4 && cacheArgument && outputArgument,
    'Usage: node scripts/entry.prepare-linux-scanners.ts <download-cache> <new-output-directory>');
const cache = resolve(cacheArgument), output = resolve(outputArgument);
const pins = JSON.parse(readFileSync(new URL('../docs/LINUX-SCANNER-PINS.json', import.meta.url), 'utf8'));
assert.equal(pins.schemaVersion, 1);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Verify every input before creating a bundle; extraction only streams named files.
const verified: {name: string; architecture: string; binary: Buffer; license: Buffer; readme: Buffer; pin: unknown}[] = [];
for (const tool of pins.tools) {
    assert(['syft', 'grype'].includes(tool.name));
    assert(/^v\d+\.\d+\.\d+$/.test(tool.version));
    const checksums = readFileSync(join(cache, `${tool.name}_${tool.version.slice(1)}_checksums.txt`));
    assert.equal(hash(checksums), tool.checksums.sha256, 'Publisher checksum list changed');
    for (const architecture of ['amd64', 'arm64']) {
        const pin = tool.platforms[architecture];
        assert.equal(pin.asset, `${tool.name}_${tool.version.slice(1)}_linux_${architecture}.tar.gz`);
        assert(checksums.toString('utf8').split(/\r?\n/).some(line => {
            const parts = line.trim().split(/\s+/);
            return parts[0] === pin.archiveSha256 && parts[1] === pin.asset;
        }), 'Archive is absent from publisher checksum list');
        const archive = join(cache, pin.asset);
        assert.equal(hash(readFileSync(archive)), pin.archiveSha256, 'Archive differs from pin');
        const extract = (name: string) => execFileSync('tar', ['-xOf', archive, name], {maxBuffer: 256 * 1024 * 1024});
        const binary = extract(tool.name);
        assert.equal(hash(binary), pin.executableSha256, 'Executable differs from pin');
        // ELF64 little-endian machine ID: AMD64=62, AArch64=183.
        assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46');
        assert.equal(binary[4], 2); assert.equal(binary[5], 1);
        assert.equal(binary.readUInt16LE(18), architecture === 'amd64' ? 62 : 183);
        verified.push({name: tool.name, architecture, binary,
            license: extract('LICENSE'), readme: extract('README.md'), pin});
    }
}
mkdirSync(output, {mode: 0o700}); // Refuse to overwrite an earlier bundle.
for (const architecture of ['amd64', 'arm64']) {
    const base = join(output, architecture);
    const directory = join(base, 'scanner-tools');
    mkdirSync(directory, {recursive: true, mode: 0o755});
    for (const item of verified.filter(item => item.architecture === architecture)) {
        writeFileSync(join(directory, item.name), item.binary, {mode: 0o755});
        writeFileSync(join(directory, item.name + '.sha256'), hash(item.binary) + '\n');
        writeFileSync(join(directory, item.name + '.LICENSE'), item.license);
        writeFileSync(join(directory, item.name + '.README.md'), item.readme);
    }
    writeFileSync(join(directory, 'provenance.json'), JSON.stringify({schemaVersion: 1, architecture,
        scope: 'Pinned publisher binaries; API/checksum agreement, not independent signature verification', pins}, null, 2) + '\n');
    const archive = join(output, `scanner-tools-linux-${architecture}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', base, 'scanner-tools'], {env: {...process.env, COPYFILE_DISABLE: '1'}});
    writeFileSync(archive + '.sha256', hash(readFileSync(archive)) + '\n');
}
console.log('Verified scanner bundles prepared for linux/amd64 and linux/arm64.');
