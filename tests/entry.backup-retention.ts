import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, readdir, rm, symlink, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {retainBackups} from '../src/backup/retention.ts';
const name = (day: number) => `bridge-202609${String(day).padStart(2, '0')}T040000Z.enc`;
await test('retention keeps newest archives and leaves unrelated, malformed and linked files untouched', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'backup-retention-')));
    try {
        for (let day = 1; day <= 5; day++) await writeFile(join(directory, name(day)), Buffer.concat([Buffer.from('TBBKUP01'), Buffer.alloc(32)]), {mode: 0o600});
        await writeFile(join(directory, 'notes.txt'), 'keep');
        await writeFile(join(directory, name(6)), 'incomplete', {mode: 0o600});
        await symlink(name(5), join(directory, name(7)));
        assert.equal(await retainBackups(directory, name(5), 2), 3);
        assert.deepEqual((await readdir(directory)).sort(), [name(4), name(5), name(6), name(7), 'notes.txt'].sort());
        assert.equal(await retainBackups(directory, name(5), 2), 0);
    } finally { await rm(directory, {recursive: true, force: true}); }
});
await test('invalid policy or a missing/newer-than-completed archive prevents deletion', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'backup-retention-')));
    try {
        for (let day = 1; day <= 3; day++) await writeFile(join(directory, name(day)), Buffer.concat([Buffer.from('TBBKUP01'), Buffer.alloc(32)]), {mode: 0o600});
        for (const [newest, count] of [[name(3), 1], [name(4), 2], [name(2), 2]] as const)
            await assert.rejects(retainBackups(directory, newest, count));
        assert.equal((await readdir(directory)).length, 3);
    } finally { await rm(directory, {recursive: true, force: true}); }
});
