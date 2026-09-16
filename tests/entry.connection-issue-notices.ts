import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConnectionIssueJournal, ConnectionIssueNotices} from '../src/operations/connection-issues.ts';
await test('typed issues persist privately, deduplicate until recovery, and survive reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'compatibility-'));
    try {
        const journal = await ConnectionIssueJournal.load(directory);
        journal.record('client-update-required'); journal.record('unknown secret');
        await journal.flush();
        assert.deepEqual(journal.snapshot().issues, {'client-update-required': {revision: 1, active: true}});
        assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
        const restarted = await ConnectionIssueJournal.load(directory);
        restarted.record('client-update-required'); await restarted.flush();
        assert.equal(restarted.snapshot().issues['client-update-required']?.revision, 1);
        restarted.recovered(); await restarted.flush();
        restarted.record('client-update-required'); restarted.record('client-was-dropped'); await restarted.flush();
        assert.equal(restarted.snapshot().issues['client-update-required']?.revision, 2);
        assert.equal(restarted.snapshot().issues['client-was-dropped']?.revision, 1);
        await writeFile(join(directory, 'state.json'), 'invalid');
        await assert.rejects(ConnectionIssueJournal.load(directory));
        await writeFile(join(directory, 'state.json'), 'x'.repeat(4097));
        await assert.rejects(ConnectionIssueJournal.load(directory), /too large/);
    } finally { await rm(directory, {recursive: true, force: true}); }
});
await test('lost notification response retries identical content after recovery and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'compatibility-notice-'));
    let ready = false, lose = true, authorizations = 0;
    const attempts: {id: string; body: unknown}[] = [], acknowledged = new Set<string>();
    try {
        let journal = await ConnectionIssueJournal.load(directory);
        journal.record('device-slot-state-mismatch');
        const options = {owner: '@owner:example.invalid', ready: () => ready, delivered: (id: string) => acknowledged.has(id),
            authorize: async () => {authorizations++; return '!management:example.invalid';},
            send: async (id: string, _room: string, content: Record<string, unknown>) => {
                assert.equal((await ConnectionIssueJournal.load(directory)).snapshot().issues['device-slot-state-mismatch']?.revision, 1);
                attempts.push({id, body: content.body});
                if (lose) {lose = false; throw new Error('Lost response');}
                acknowledged.add(id);
            }};
        assert.equal(await new ConnectionIssueNotices({...options, journal}).drain(), 0);
        assert.equal(authorizations, 0);
        ready = true;
        await assert.rejects(new ConnectionIssueNotices({...options, journal}).drain(), /Lost response/);
        journal.recovered(); await journal.flush();
        journal = await ConnectionIssueJournal.load(directory);
        assert.equal(await new ConnectionIssueNotices({...options, journal}).drain(), 1);
        assert.deepEqual(attempts[0], attempts[1]);
        assert.equal(await new ConnectionIssueNotices({...options, journal}).drain(), 0);
    } finally { await rm(directory, {recursive: true, force: true}); }
});
await test('failed persistence blocks delivery and retries without losing the typed issue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'compatibility-storage-'));
    const path = join(directory, 'state-directory'); let sends = 0;
    try {
        const journal = await ConnectionIssueJournal.load(path);
        await writeFile(path, 'block directory creation');
        journal.record('mediator-update-required');
        const options = {owner: '@owner:example.invalid', journal, ready: () => true,
            delivered: () => false, authorize: async () => '!management:example.invalid',
            send: async () => {sends++;}};
        await assert.rejects(new ConnectionIssueNotices(options).drain());
        assert.equal(sends, 0); assert.deepEqual(journal.snapshot().issues, {});
        await rm(path);
        await assert.rejects(new ConnectionIssueNotices({...options, authorize: async () => {throw new Error('Unauthorized');}}).drain(), /Unauthorized/);
        assert.equal(sends, 0);
        assert.equal(await new ConnectionIssueNotices(options).drain(), 1);
        assert.equal(sends, 1);
        assert(!String(await readFile(join(path, 'state.json'))).includes('block directory'));
    } finally { await rm(directory, {recursive: true, force: true}); }
});
