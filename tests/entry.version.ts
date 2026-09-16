import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {sourceVersion} from '../src/service/version.ts';

await test('version emits deterministic source hashes without relying on cwd or opening a profile', async () => {
    const first = await sourceVersion();
    assert.deepEqual(await sourceVersion(), first);
    const entry = first.source.files.find((file) => file.path === 'src/service/start.ts')!;
    assert.equal(
        entry.sha256,
        createHash('sha256')
            .update(await readFile(new URL('../src/service/start.ts', import.meta.url)))
            .digest('hex'),
    );
    assert.equal(
        new Set(first.source.files.map((file) => file.path)).size,
        first.source.files.length,
    );
    assert.ok(
        first.source.files.every(
            (file) => !file.path.startsWith('/') && !file.path.includes('.local/'),
        ),
    );
    assert.equal(first.release, null);
    assert(!first.source.files.some(file => file.path === 'Threema-Beeper-Bridge-Implementation-Handoff.md'));
    for (const path of ['native/media-limits.c', 'native/node24/cleanup-hooks.patch',
        'deploy/threema-upstream-check.timer', 'deploy/docker/Dockerfile.native']) {
        const file = first.source.files.find(entry => entry.path === path);
        assert(file, `Missing source manifest entry: ${path}`);
        assert.equal(file.sha256, createHash('sha256')
            .update(await readFile(new URL('../' + path, import.meta.url))).digest('hex'));
    }
    assert.equal(first.verification.bbctlExecutable, 'not-checked');
    assert.equal(
        first.source.repositories.find((repo: {name: string}) => repo.name === 'bridge-manager')
            .commit,
        '621b50c3c9e395eda28ebe522a1406fdef71c8c9',
    );
    const result = await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL('../src/service/entry.version.ts', import.meta.url)), '--json'],
        {cwd: tmpdir(), maxBuffer: 4 * 1024 * 1024},
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), first);
});
