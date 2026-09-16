import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn, execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {ProfileLock} from '../src/threema/profile-lock.ts';

await test('a killed weekly check releases ownership and the next CLI run succeeds without deleting lock files', {timeout: 15_000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'upstream-restart-'));
    const preload = (code: string) => 'data:text/javascript,' + encodeURIComponent(code);
    const entry = resolve('src/service/entry.upstream-monitor.ts');
    const hanging = spawn(process.execPath, ['--import', preload(`
        setInterval(() => {}, 1000);
        globalThis.fetch = async () => {process.stdout.write('checking\\n'); return new Promise(() => {});};
    `), entry, directory], {stdio: ['ignore', 'pipe', 'pipe']});
    try {
        await once(hanging.stdout, 'data', {signal: AbortSignal.timeout(5000)});
        assert.throws(() => new ProfileLock(join(directory, 'coordination')), /already open/u);
        const exited = once(hanging, 'exit');
        hanging.kill('SIGKILL');
        await exited;
        const result = await promisify(execFile)(process.execPath, ['--import', preload(`
            globalThis.fetch = async url => new Response(String(url).includes('/tags?')
                ? JSON.stringify([{name:'v2.0-beta65', commit:{sha:'a'.repeat(40)}}])
                : '<html><body>' + 'synthetic page '.repeat(20) + '</body></html>');
        `), entry, directory]);
        assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
        const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
        assert.deepEqual(Object.keys(state.snapshots).sort(), ['changelog', 'tags', 'terms']);
        assert.deepEqual(state.pending, {});
    } finally {
        if (hanging.exitCode === null && hanging.signalCode === null) {
            const exited = once(hanging, 'exit'); hanging.kill('SIGKILL'); await exited;
        }
        await rm(directory, {recursive: true, force: true});
    }
});

await test('local review persists one exact revision, rejects stale review and performs no fetch', async () => {
    const {writeFile} = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'upstream-review-'));
    const file = join(directory, 'state.json');
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [
        '--import', 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("Unexpected network access"); };'),
        resolve('src/service/entry.upstream-monitor.ts'), directory, ...args,
    ]);
    const original = {schemaVersion: 1, snapshots: {terms: 'a'.repeat(64), tags: 'b'.repeat(64)},
        pending: {terms: 'changed', tags: 'changed'}, revisions: {terms: 2, tags: 1}};
    try {
        await writeFile(file, JSON.stringify(original), {mode: 0o600});
        assert.deepEqual(JSON.parse((await run('status')).stdout), {pending: original.pending, revisions: original.revisions});
        const before = await readFile(file, 'utf8');
        await assert.rejects(run('review', 'terms', '1'));
        assert.equal(await readFile(file, 'utf8'), before);
        await run('review', 'terms', '2');
        const reviewed = JSON.parse(await readFile(file, 'utf8'));
        assert.deepEqual(reviewed.pending, {tags: 'changed'});
        assert.deepEqual(reviewed.snapshots, original.snapshots);
        await run('review', 'terms', '2'); // Lost command response is safe to retry.
        reviewed.pending.terms = 'changed'; reviewed.revisions.terms = 3;
        await writeFile(file, JSON.stringify(reviewed));
        await assert.rejects(run('review', 'terms', '2'));
        assert.equal(JSON.parse(await readFile(file, 'utf8')).pending.terms, 'changed');
        reviewed.pending.terms = 'unavailable';
        await writeFile(file, JSON.stringify(reviewed));
        await assert.rejects(run('review', 'terms', '3'));
        const lock = new ProfileLock(join(directory, 'coordination'));
        try { await assert.rejects(run('review', 'tags', '1')); }
        finally { lock.close(); }
        assert.equal(JSON.parse(await readFile(file, 'utf8')).pending.tags, 'changed');
    } finally { await rm(directory, {recursive: true, force: true}); }
});
