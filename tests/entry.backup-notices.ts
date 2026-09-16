import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordBackupStatus, readBackupStatus, parseBackupStatus, type BackupStatus} from '../src/backup/status.ts';
import {BackupNotices} from '../src/operations/backup-notices.ts';

await test('backup incidents survive recovery, deduplicate repeated failures, and reject corrupt state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-status-'));
    try {
        assert.equal(await readBackupStatus(directory), undefined);
        await recordBackupStatus(directory, 'success');
        assert.equal((await readBackupStatus(directory))?.incident, undefined);
        await recordBackupStatus(directory, 'failed');
        const first = (await readBackupStatus(directory))!.incident;
        assert(first);
        await recordBackupStatus(directory, 'failed');
        assert.equal((await readBackupStatus(directory))?.incident, first);
        await recordBackupStatus(directory, 'success');
        assert.equal((await readBackupStatus(directory))?.incident, first);
        await recordBackupStatus(directory, 'failed');
        assert.notEqual((await readBackupStatus(directory))?.incident, first);
        assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
        await writeFile(join(directory, 'state.json'), 'x'.repeat(2049));
        await assert.rejects(readBackupStatus(directory), /too large/u);
        await assert.rejects(recordBackupStatus(directory, 'success'), /too large/u);
        assert.throws(() => parseBackupStatus({schemaVersion: 1, lastResult: 'failed'}));
        assert.throws(() => parseBackupStatus({schemaVersion: 1, lastResult: 'failed', incident: 'secret'}));
    } finally { await rm(directory, {recursive: true, force: true}); }
});

await test('backup warnings stay quiet on success and retry identical content after lost response and recovery', async () => {
    let state: BackupStatus = {schemaVersion: 1, lastResult: 'success'};
    let ready = true, authorizations = 0, loseResponse = true;
    const delivered = new Set<string>();
    const sends: {id: string; content: Record<string, unknown>}[] = [];
    const options = {
        owner: '@owner:example.invalid', ready: () => ready,
        load: async () => state, delivered: (id: string) => delivered.has(id),
        authorize: async () => { authorizations++; return '!maintenance:example.invalid'; },
        send: async (id: string, room: string, content: Record<string, unknown>) => {
            assert.equal(room, '!maintenance:example.invalid');
            sends.push({id, content});
            if (loseResponse) { loseResponse = false; throw new Error('Lost response'); }
            delivered.add(id);
        },
    };
    assert.equal(await new BackupNotices(options).drain(), 0);
    assert.equal(authorizations, 0);
    state = {schemaVersion: 1, lastResult: 'failed', incident: '11111111-1111-4111-8111-111111111111'};
    await assert.rejects(new BackupNotices(options).drain(), /Lost response/u);
    state.lastResult = 'success';
    assert.equal(await new BackupNotices(options).drain(), 1);
    assert.deepEqual(sends[0], sends[1]);
    assert.equal(await new BackupNotices(options).drain(), 0);
    state = {...state, lastResult: 'failed', incident: '22222222-2222-4222-8222-222222222222'};
    ready = false;
    assert.equal(await new BackupNotices(options).drain(), 0);
    ready = true;
    await assert.rejects(new BackupNotices({...options, authorize: async () => {
        throw new Error('Unauthorized');
    }}).drain(), /Unauthorized/u);
    assert.equal(sends.length, 2);
    assert.equal(await new BackupNotices({...options, authorize: async () => {
        ready = false; return '!maintenance:example.invalid';
    }}).drain(), 0);
    ready = true;
    assert.equal(await new BackupNotices(options).drain(), 1);
    assert.notEqual(sends[0]!.id, sends[2]!.id);
});
