import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
assert([3, 4].includes(process.argv.length),
    'Usage: node scripts/entry.scan-vulnerabilities.ts <new-output-directory> [database-cache-directory]');
const output = resolve(process.argv[2]!);
const databaseDirectory = resolve(process.argv[3] ?? join(root, '.local/grype-db'));
const pins = JSON.parse(readFileSync(join(root, 'docs/VULNERABILITY-TOOL-PINS.json'), 'utf8'));
const coverage = JSON.parse(readFileSync(join(root, 'docs/SBOM-COVERAGE.json'), 'utf8'));
const observations = JSON.parse(readFileSync(join(root, 'docs/LINUX-IMAGE-OBSERVATIONS.json'), 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
assert(/^v\d+\.\d+\.\d+$/.test(pins.version));
const binary = join(root, '.local/bin', 'grype-' + pins.version, 'grype');
assert.equal(hash(readFileSync(binary)), pins.executableSha256, 'Scanner executable differs from pin');
mkdirSync(output);
const config = join(output, 'scanner-config.json');
writeFileSync(config, JSON.stringify({
    'check-for-app-update': false,
    db: {'cache-dir': databaseDirectory, 'auto-update': false},
    ignore: [],
}) + '\n');
// Do not let inherited scanner overrides silently suppress findings or enable network updates.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GRYPE_')));
const run = (...args: string[]) => execFileSync(binary, ['--config', config, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 128 * 1024 * 1024,
});
const database = JSON.parse(run('db', 'status', '-o', 'json'));
writeFileSync(join(output, 'database.json'), JSON.stringify(database, null, 2) + '\n');
const images = [];
for (const architecture of ['amd64', 'arm64']) {
    const input = coverage.images.find((item: any) => item.architecture === architecture);
    const observation = observations.images.find((item: any) => item.architecture === architecture);
    assert(input && observation && input.imageId === observation.imageId, 'Inventory/image mismatch');
    const report = input.outputs.find((item: any) => item.format === 'syft');
    assert(report, 'Missing Syft inventory');
    const source = resolve(root, report.path);
    assert.equal(hash(readFileSync(source)), report.sha256, 'Inventory bytes changed');
    const bytes = run('sbom:' + source, '-o', 'json');
    const findings = JSON.parse(bytes);
    assert.equal(findings.source.type, 'image', 'Scan lost image provenance');
    assert.equal(findings.source.target.imageID, input.imageId, 'Scan describes a different image');
    const filename = architecture + '.grype.json';
    writeFileSync(join(output, filename), bytes);
    const severity: Record<string, number> = {};
    const prioritized = [];
    for (const match of findings.matches) {
        const level = match.vulnerability.severity;
        severity[level] = (severity[level] ?? 0) + 1;
        if (level === 'Critical' || level === 'High') prioritized.push({
            id: match.vulnerability.id, severity: level,
            package: match.artifact.name, version: match.artifact.version,
            type: match.artifact.type, fix: match.vulnerability.fix,
            dataSource: match.vulnerability.dataSource,
        });
    }
    images.push({architecture, imageId: input.imageId, inventorySha256: report.sha256,
        report: filename, reportSha256: hash(Buffer.from(bytes)), severity, prioritized});
}
writeFileSync(join(output, 'summary.json'), JSON.stringify({
    schemaVersion: 1, observedAt: new Date().toISOString(), scanner: pins, database,
    images, releaseReady: false,
    limitations: ['Findings require applicability review; counts are package-vulnerability matches, not unique vulnerabilities.',
        'Scanner coverage is limited by the inventoried components; compiled Rust/WASM and static-codec inventory gaps remain.'],
}, null, 2) + '\n');
console.log(JSON.stringify(images.map(({architecture, severity}) => ({architecture, severity}))));
