import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, copyFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {verifyContextIntegrity} from './linux-context-integrity.ts';

const root = resolve(import.meta.dirname, '..');
const [argument, generation = 'migration'] = process.argv.slice(2);
assert([3, 4].includes(process.argv.length) && argument && ['alerts', 'disk', 'recovery', 'migration'].includes(generation),
    'Usage: node scripts/entry.export-linux-candidate.ts <new-directory-under-.local> [migration|recovery|disk|alerts]');
const output = resolve(argument);
assert(output.startsWith(join(root, '.local') + sep) && !existsSync(output), 'Use a new output directory under .local');
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const checked = (path: string, expected: string): string => {
    const full = resolve(root, path);
    assert(full.startsWith(root + sep) && lstatSync(full).isFile() && !lstatSync(full).isSymbolicLink(), 'Invalid evidence path');
    assert.equal(hash(readFileSync(full)), expected, `Evidence changed: ${path}`);
    return full;
};
const verificationPath = `docs/LINUX-${generation.toUpperCase()}-VERIFICATION.json`;
const verification = json(verificationPath);
const generationInventory = generation !== 'alerts' ? json(`docs/LINUX-${generation.toUpperCase()}-INVENTORY.json`) : undefined;
const observations = generationInventory ? {images: verification.images.map((i: any) => i.observation)} : json('docs/LINUX-IMAGE-OBSERVATIONS.json');
const coverage = generationInventory ? {images: generationInventory.images.map((i: any) => i.inventory)} : json('docs/SBOM-COVERAGE.json');
const scan = generationInventory ? {images: generationInventory.images.map((i: any) => ({architecture: i.architecture,
    imageId: i.inventory.imageId, reportPath: i.scan.path, reportSha256: i.scan.sha256, severity: i.severity}))} : json('docs/VULNERABILITY-SCAN.json');
const scanReview = json('docs/NODE-CLEANUP-IMAGE-REVIEW.json');
const scannerBundles = json('docs/LINUX-SCANNER-VERIFICATION.json');
const context = resolve(root, verification.context);
assert(context.startsWith(join(root, '.local') + sep));
const inputSha256 = verifyContextIntegrity(context);
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();
assert.equal(git('diff', '--name-only', 'HEAD', '--', 'docs', 'deploy', 'src', 'native', 'scripts'), '', 'Commit export inputs first');
const evidence: {source: string; destination: string}[] = [];
const images: {architecture: string; imageId: string}[] = [];
for (const architecture of ['amd64', 'arm64']) {
    const verified = verification.images.find((i: any) => i.architecture === architecture);
    const observed = observations.images.find((i: any) => i.architecture === architecture);
    const inventory = coverage.images.find((i: any) => i.architecture === architecture);
    const report = scan.images.find((i: any) => i.architecture === architecture);
    assert(verified && observed && inventory && report, 'Missing architecture evidence');
    assert.equal(verified.packageTestsPassed, generation === 'migration' ? 97 : generation === 'recovery' ? 95 : generation === 'disk' ? 89 : 86); assert.equal(verified.codecTestsPassed, 13);
    const imageId = observed.imageId;
    assert(/^sha256:[a-f0-9]{64}$/.test(imageId));
    for (const candidate of [verified.observation, inventory, report]) assert.equal(candidate.imageId, imageId);
    assert.equal(observed.inputSha256, inputSha256);
    for (const item of verified.evidence) {
        evidence.push({source: checked(item.path, item.sha256), destination: `evidence/tests/${architecture}-${item.path.split('/').at(-1)}`});
    }
    for (const item of inventory.outputs) evidence.push({source: checked(item.path, item.sha256), destination: `evidence/inventory/${architecture}.${item.format}.json`});
    evidence.push({source: checked(report.reportPath ?? join(scanReview.reportDirectory, report.report), report.reportSha256), destination: `evidence/scans/${architecture}.grype.json`});
    const bundle = scannerBundles.architectures[architecture];
    evidence.push({source: checked(bundle.bundle, bundle.bundleSha256), destination: `scanner-tools-linux-${architecture}.tar.gz`});
    const [metadata] = JSON.parse(execFileSync('docker', ['image', 'inspect', imageId], {encoding: 'utf8'}));
    assert.equal(metadata.Architecture, architecture);
    assert.equal(metadata.Config.User, '1000:1000');
    assert.deepEqual(metadata.Config.Entrypoint, ['/usr/bin/tini', '-g', '--', 'node', 'src/service/entry.service.ts']);
    images.push({architecture, imageId});
}
mkdirSync(output, {mode: 0o700});
const copy = (source: string, target: string) => {
    mkdirSync(dirname(target), {recursive: true}); copyFileSync(source, target);
};
for (const item of evidence) copy(item.source, join(output, item.destination));
// Only tracked public documentation, plus deployment files from the exact tested context.
const publicFiles = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'docs', 'deploy'], {encoding: 'utf8'}).split('\0').filter(Boolean);
for (const path of publicFiles) {
    const source = path.startsWith('deploy/') ? join(context, path) : join(root, path);
    assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 'Unexpected public bundle entry');
    copy(source, join(output, 'deployment', path));
}
for (const {architecture, imageId} of images) {
    writeFileSync(join(output, 'deployment', `.env.${architecture}`), `BRIDGE_IMAGE=${imageId}\nBRIDGE_PLATFORM=linux/${architecture}\n`);
}
writeFileSync(join(output, 'deployment', 'CANDIDATE.txt'), 'Private test candidate. Security review and target-host acceptance remain open. No account data is included. Copy deploy files into the installation directory and select .env.amd64 or .env.arm64 as .env. Do not run two copies of a linked profile.\n');
execFileSync('tar', ['-czf', join(output, 'deployment.tar.gz'), '-C', output, 'deployment'], {env: {...process.env, COPYFILE_DISABLE: '1'}});
execFileSync('tar', ['-czf', join(output, 'evidence.tar.gz'), '-C', output, 'evidence'], {env: {...process.env, COPYFILE_DISABLE: '1'}});
const sourceOutput = join(output, 'source-supplements');
execFileSync('python3', [join(root, 'scripts/export-source-supplements.py'), sourceOutput,
    ...(generation !== 'alerts' ? [verificationPath, `docs/PRIMARY-${generation.toUpperCase()}-SOURCE-VERIFICATION.json`] : [])], {stdio: 'inherit'});
copy(join(sourceOutput, 'sources.tar.gz'), join(output, 'sources.tar.gz'));
copy(join(sourceOutput, 'sources.json'), join(output, 'source-supplements.json'));
const artifacts: {file: string; bytes: number; sha256: string}[] = [];
for (const {architecture, imageId} of images) {
    const file = `threema-beeper-${architecture}.tar.gz`;
    const child = spawn('docker', ['image', 'save', imageId], {stdio: ['ignore', 'pipe', 'inherit']});
    const completed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Image export failed: ${code ?? signal}`)));
    });
    try { await Promise.all([completed, pipeline(child.stdout!, createGzip({level: 6}), createWriteStream(join(output, file), {flags: 'wx', mode: 0o600}))]); }
    catch (error) { child.kill('SIGTERM'); throw error; }
}
for (const file of ['threema-beeper-amd64.tar.gz', 'threema-beeper-arm64.tar.gz', 'deployment.tar.gz', 'evidence.tar.gz', 'sources.tar.gz', 'source-supplements.json', 'scanner-tools-linux-amd64.tar.gz', 'scanner-tools-linux-arm64.tar.gz']) {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(join(output, file))) digest.update(chunk);
    artifacts.push({file, bytes: lstatSync(join(output, file)).size, sha256: digest.digest('hex')});
}
const manifest = {schemaVersion: 1, kind: 'private-test-candidate', releaseReady: false,
    sourceSupplements: {manifest: 'source-supplements.json', archive: 'sources.tar.gz', completeCorrespondingSource: false},
    evidenceCommit: git('rev-parse', 'HEAD'), sourceCommit: verification.sourceCommit,
    inputSha256, images, artifacts, securityReview: {status: 'open', images: scan.images.map((i: any) => ({architecture: i.architecture, severity: i.severity}))},
    limitations: verification.limitations, scope: 'Local exports only; no signing, account data, target-host deployment or release approval'};
writeFileSync(join(output, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(output, 'SHA256SUMS'), [...artifacts.map(a => `${a.sha256}  ${a.file}`), `${hash(readFileSync(join(output, 'release.json')))}  release.json`].join('\n') + '\n');
console.log(`Candidate exported to ${relative(root, output)}. Release acceptance remains open.`);
