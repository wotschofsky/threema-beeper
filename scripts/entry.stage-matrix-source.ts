import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeContextIntegrity} from './linux-context-integrity.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[3] ?? 'build';
assert(process.argv.length <= 4 && ['build', 'vendor'].includes(mode), 'Usage: node scripts/entry.stage-matrix-source.ts [new-output-directory] [build|vendor]');
const output = resolve(process.argv[2] ?? join(root, '.local/matrix-native-source-context'));
assert(output.startsWith(join(root, '.local') + sep));
assert(!existsSync(output), 'Use a fresh Matrix source context');
const pin = JSON.parse(readFileSync(join(root, 'docs/MATRIX-CRYPTO-PINS.json'), 'utf8'));
assert(/^[0-9a-f]{40}$/u.test(pin.sourceCommit));
const archive = execFileSync(
    'git',
    [
        '-C',
        join(root, '.local/sources/matrix-rust-sdk-crypto-nodejs'),
        'archive',
        '--format=tar',
        pin.sourceCommit,
    ],
    {maxBuffer: 64 * 1024 * 1024},
);
mkdirSync(join(output, 'source'), {recursive: true});
execFileSync('tar', ['-xf', '-', '-C', join(output, 'source')], {input: archive});
assert.equal(
    JSON.parse(readFileSync(join(output, 'source/package.json'), 'utf8')).version,
    pin.version,
);
writeFileSync(
    join(output, 'Dockerfile'),
    readFileSync(join(root, `deploy/docker/Dockerfile.matrix-${mode === 'vendor' ? 'vendor' : 'native'}`)),
);
writeFileSync(join(output, '.dockerignore'), '**/.DS_Store\n');
writeFileSync(join(output, 'source-pin.json'), JSON.stringify(pin, null, 2) + '\n');
console.log(`Matrix source context: ${writeContextIntegrity(output)}`);
