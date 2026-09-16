import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeContextIntegrity} from './linux-context-integrity.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[3] ?? 'build';
assert(process.argv.length <= 4 && ['build', 'vendor'].includes(mode), 'Usage: node scripts/entry.stage-wasm.ts [new-output-directory] [build|vendor]');
const output = resolve(process.argv[2] ?? join(root, '.local/wasm-source-context'));
assert(output.startsWith(join(root, '.local') + sep));
assert(!existsSync(output), 'Use a fresh WASM source context');
const pins = JSON.parse(readFileSync(join(root, 'docs/SOURCE-PINS.json'), 'utf8'));
const pin = pins.repositories.find((item: {name: string}) => item.name === 'threema-desktop');
assert(pin && /^[0-9a-f]{40}$/u.test(pin.commit));
const prefix = 'packages/libthreema-wasm/libs/libthreema';
const archive = execFileSync(
    'git',
    [
        '-C',
        join(root, '.local/sources/threema-desktop'),
        'archive',
        '--format=tar',
        pin.commit,
        prefix,
    ],
    {maxBuffer: 64 * 1024 * 1024},
);
mkdirSync(output, {recursive: true});
execFileSync('tar', ['-xf', '-', '-C', output], {input: archive});
writeFileSync(join(output, 'Dockerfile'), readFileSync(join(root, `deploy/docker/Dockerfile.wasm${mode === 'vendor' ? '-vendor' : ''}`)));
writeFileSync(join(output, '.dockerignore'), '**/.DS_Store\n');
writeFileSync(join(output, 'source-pin.json'), JSON.stringify(pin, null, 2) + '\n');
console.log(`WASM source context: ${writeContextIntegrity(output)}`);
