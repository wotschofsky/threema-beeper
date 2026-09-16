import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, join, relative, resolve, sep} from 'node:path';

// A supplemental archive of primary repositories, not a complete corresponding-source claim.
const root = resolve(import.meta.dirname, '..');
const [argument, verificationArgument = 'docs/LINUX-ALERTS-VERIFICATION.json'] = process.argv.slice(2);
assert([3, 4].includes(process.argv.length) && argument, 'Usage: node scripts/entry.export-primary-source.ts <new-directory-under-.local> [verification-json]');
const output = resolve(argument);
assert(output.startsWith(join(root, '.local') + sep) && !existsSync(output), 'Use a new directory under .local');
const git = (repository: string, ...args: string[]) => execFileSync('git', ['-C', repository, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const verificationPath = resolve(root, verificationArgument);
assert(verificationPath.startsWith(root + sep), 'Verification must be inside the checkout');
const verification = JSON.parse(readFileSync(verificationPath, 'utf8'));
const inputSha256 = verification.images[0]?.observation.inputSha256;
assert(typeof inputSha256 === 'string' && /^[a-f0-9]{64}$/.test(inputSha256));
assert(verification.images.every((image: {observation: {inputSha256: string}}) => image.observation.inputSha256 === inputSha256));
const sourceCommit = git(root, 'rev-parse', '--verify', `${verification.sourceCommit}^{commit}`).trim();
// Use pins from the image's source revision, not a later worktree or branch tip.
const pins = JSON.parse(git(root, 'show', `${sourceCommit}:docs/SOURCE-PINS.json`));
const repositories: {name: string; commit: string; repository: string}[] = [
    {name: 'threema-beeper', commit: sourceCommit, repository: root},
    ...pins.repositories.map((pin: {name: string; commit: string}) => {
        assert(/^[a-z0-9-]+$/.test(pin.name) && /^[a-f0-9]{40}$/.test(pin.commit), 'Invalid repository pin');
        return {name: pin.name, commit: pin.commit, repository: join(root, '.local/sources', pin.name)};
    }),
];
assert.equal(new Set(repositories.map(item => item.name)).size, repositories.length);
const plans = repositories.map(item => {
    assert.equal(git(item.repository, 'rev-parse', '--verify', `${item.commit}^{commit}`).trim(), item.commit);
    const entries = git(item.repository, 'ls-tree', '-rz', item.commit).split('\0').filter(Boolean).map(line => {
        const tab = line.indexOf('\t');
        assert(tab > 0 && !line.startsWith('160000 '), 'Submodule sources require explicit archival');
        const path = line.slice(tab + 1);
        assert(!/[\r\n]/.test(path), 'Unsupported archive filename');
        return path;
    });
    const notices = entries.filter(path => /^(licen[cs]e|notice|copying|copyright)([.\-_]|$)/i.test(basename(path)) || path.split('/').includes('.licenses'));
    assert(notices.length > 0, `No license notices found for ${item.name}`);
    return {...item, entries, notices};
});
mkdirSync(output, {mode: 0o700});
const archives = [];
for (const plan of plans) {
    const file = `${plan.name}.tar.gz`;
    const archive = join(output, file);
    git(plan.repository, 'archive', '--format=tar.gz', `--prefix=${plan.name}/`, `--output=${archive}`, plan.commit);
    const paths = execFileSync('tar', ['-tzf', archive], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}).trimEnd().split('\n').filter(path => !path.endsWith('/'));
    assert.deepEqual(paths.sort(), plan.entries.map(path => `${plan.name}/${path}`).sort(), 'Git export attributes omitted or added source files');
    const notices = plan.notices.map(path => {
        const original = execFileSync('git', ['-C', plan.repository, 'show', `${plan.commit}:${path}`], {maxBuffer: 64 * 1024 * 1024});
        const archived = execFileSync('tar', ['-xOf', archive, `${plan.name}/${path}`], {maxBuffer: 64 * 1024 * 1024});
        assert.equal(hash(archived), hash(original), `Notice changed: ${path}`);
        return {path, sha256: hash(original)};
    });
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(archive)) digest.update(chunk);
    archives.push({name: plan.name, commit: plan.commit, file, bytes: statSync(archive).size, sha256: digest.digest('hex'), trackedFiles: paths.length, notices});
    console.log(`Verified ${plan.name}: ${paths.length} tracked files, ${notices.length} notice files`);
}
const manifest = {
    schemaVersion: 1, kind: 'primary-source-supplement', completeCorrespondingSource: false,
    sourceCommit, inputSha256,
    verificationSha256: hash(readFileSync(verificationPath)),
    archives,
    remaining: [
        'Registry npm and Cargo dependency sources and their complete notices',
        'Transitive Git dependencies, including matrix-rust-sdk',
        'Native codec, Node and operating-system dependency source archives and notices',
        'Complete build-tool inputs, source-to-binary coverage and reproducibility verification',
        'Formal license review before distribution or shared use',
    ],
};
writeFileSync(join(output, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(output, 'SHA256SUMS'), [...archives.map(item => `${item.sha256}  ${item.file}`), `${hash(readFileSync(join(output, 'source.json')))}  source.json`].join('\n') + '\n');
console.log(`Primary sources exported to ${relative(root, output)}; completeness remains open.`);
