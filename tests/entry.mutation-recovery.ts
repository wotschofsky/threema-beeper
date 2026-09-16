import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {MutationRecovery} from '../src/outbox/mutation-recovery.ts';
import type {MutationOperation} from '../src/outbox/mutation-journal.ts';

await test('mutation recovery settles matching uncertain parts without retrying mismatches or bypassing authorization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-recovery-')),
        key = randomBytes(32),
        path = join(directory, 'outbox');
    let store = new OutboxStore(path, key);
    const operation: MutationOperation = {
        profile: 'SELF1234',
        owner: '@owner:invalid',
        room: '!room:invalid',
        chat: 'c:ABCD1234',
        event: '$change',
        target: '$original',
        commands: [1, 2].map((part) => ({
            profile: 'SELF1234',
            chatId: 'c:ABCD1234',
            messageId: `m:${part.toString(16).padStart(16, '0')}`,
            action: 'delete',
        })),
    };
    let matches = false,
        ready = true,
        fail = false,
        revoke = false,
        authorizations = 0,
        queries = 0;
    const worker = () =>
        new MutationRecovery({
            profile: operation.profile,
            journal: store.mutations,
            ready: () => ready,
            authorize: async (value) => {
                authorizations++;
                value.commands.length = 0;
                if (revoke && authorizations % 2 === 0) throw new Error('Revoked');
            },
            backend: {
                mutationState: async (command) => {
                    queries++;
                    assert.equal(command.messageId, operation.commands[0]!.messageId);
                    if (fail) throw new Error('Offline');
                    return matches;
                },
            },
        });
    try {
        store.mutations.prepare(operation);
        assert.equal(
            store.mutations.observeDesiredState(operation.profile, operation.event, 0, true),
            false,
        );
        assert(store.mutations.claim(operation.profile, operation.event, 0));
        assert.equal(store.mutations.uncertain(operation.profile, 10).length, 0);
        store.close();
        store = new OutboxStore(path, key);
        store.recoverInterrupted();
        assert.equal(store.mutations.uncertain('OTHER123', 10).length, 0);
        assert.equal(store.mutations.uncertain(operation.profile, 10).length, 1);
        assert.equal(await worker().drain(), 0);
        assert.equal(store.mutations.claim(operation.profile, operation.event, 0), false);
        assert.equal(store.mutations.claim(operation.profile, operation.event, 1), false);
        fail = true;
        await assert.rejects(worker().drain());
        fail = false;
        matches = true;
        revoke = true;
        authorizations = 0;
        await assert.rejects(worker().drain());
        assert.equal(
            store.mutations.get(operation.profile, operation.event)!.states[0],
            'OUTCOME_UNKNOWN',
        );
        revoke = false;
        ready = false;
        const before = queries;
        assert.equal(await worker().drain(), 0);
        assert.equal(queries, before);
        ready = true;
        assert.equal(await worker().drain(), 1);
        assert.deepEqual(store.mutations.get(operation.profile, operation.event)!.states, [
            'APPLIED',
            'PREPARED',
        ]);
        assert.equal(await worker().drain(), 0);
        assert.equal(
            store.mutations.observeDesiredState(operation.profile, operation.event, 0, true),
            false,
        );
        store.close();
        store = new OutboxStore(path, key);
        assert.equal(store.mutations.uncertain(operation.profile, 10).length, 0);
        assert(
            store.mutations.claim(operation.profile, operation.event, 1),
            'Only the never-attempted tail becomes eligible',
        );
        assert.equal(
            store.mutations.observeDesiredState(operation.profile, operation.event, 1, true),
            false,
        );
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
