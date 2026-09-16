import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {OutboxStore} from '../src/outbox/store.ts';
import type {MutationOperation} from '../src/outbox/mutation-journal.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
await test('schema 13 migration preserves sends and mutation restart never retries an uncertain part', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-journal-')),
        key = randomBytes(32),
        path = join(directory, 'outbox');
    let store = new OutboxStore(path, key);
    const profile = 'SELF1234',
        chat = 'c:ABCD1234',
        owner = '@owner:invalid',
        room = '!room:invalid';
    const text = {
        requestId: createRequestId(),
        profile,
        sender: owner,
        roomId: room,
        chatId: chat,
        eventId: '$original',
        transactionId: 'original',
        text: 'Original',
    };
    const operation: MutationOperation = {
        profile,
        chat,
        owner,
        room,
        event: '$edit',
        target: '$original',
        commands: [
            {
                profile,
                chatId: chat,
                messageId: 'm:0100000000000000',
                action: 'edit',
                text: 'Shorter text',
            },
            {profile, chatId: chat, messageId: 'm:0200000000000000', action: 'delete'},
        ],
    };
    try {
        store.prepare(text);
        store.close();
        const old = new Database(path);
        old.pragma('cipher_compatibility = 4');
        old.pragma(`key = "x'${key.toString('hex')}'"`);
        old.exec(
            'DROP TABLE mutation_parts; DROP TABLE mutation_operations; PRAGMA user_version=13;',
        );
        old.close();
        store = new OutboxStore(path, key);
        assert.equal(store.forEvent(profile, '$original')!.state, 'PREPARED');
        store.mutations.prepare(operation);
        store.mutations.prepare(structuredClone(operation));
        assert.throws(
            () => store.mutations.prepare({...operation, target: '$different'}),
            /conflict/,
        );
        assert.throws(
            () =>
                store.mutations.prepare({
                    ...operation,
                    event: '$original',
                    target: '$other-target',
                }),
            /classified/,
        );
        assert.throws(() => store.rejectEvent(profile, '$edit', room, 'No'), /Mutation/);
        assert.throws(
            () => store.prepare({...text, requestId: createRequestId(), eventId: '$edit'}),
            /mutation/,
        );
        assert.throws(
            () =>
                store.reactions.prepare({
                    profile,
                    chat,
                    owner,
                    room,
                    event: '$edit',
                    target: '$original',
                    messages: ['m:0100000000000000'],
                    emoji: '👍',
                    action: 'apply',
                }),
            /mutation/,
        );
        assert.throws(() =>
            store.mutations.prepare({
                ...operation,
                event: '$invalid',
                commands: [operation.commands[0]!, operation.commands[0]!],
            }),
        );
        assert.throws(() =>
            store.mutations.prepare({
                ...operation,
                event: '$wrong-profile',
                commands: [{...operation.commands[0]!, profile: 'OTHER123'}],
            }),
        );
        assert.throws(() =>
            store.mutations.prepare({
                ...operation,
                event: '$secret',
                token: 'secret',
            } as MutationOperation),
        );
        assert.equal(store.mutations.claim(profile, '$edit', 1), false);
        assert.equal(store.mutations.claim(profile, '$edit', 0), true);
        assert.equal(store.mutations.claim(profile, '$edit', 0), false);
        store.mutations.finish(profile, '$edit', 0, 'APPLIED');
        assert.equal(store.mutations.claim(profile, '$edit', 1), true);
        store.mutations.prepare({...operation, event: '$later'});
        const other = {
            ...operation,
            event: '$other',
            chat: 'c:OTHER123',
            commands: operation.commands.map((command) => ({...command, chatId: 'c:OTHER123'})),
        };
        store.mutations.prepare(other);
        store.close();
        store = new OutboxStore(path, key);
        store.recoverInterrupted();
        assert.deepEqual(store.mutations.get(profile, '$edit')!.states, [
            'APPLIED',
            'OUTCOME_UNKNOWN',
        ]);
        assert.equal(store.mutations.claim(profile, '$edit', 1), false);
        assert.equal(store.mutations.claim(profile, '$later', 0), false);
        assert.equal(store.mutations.peek(profile)!.operation.event, '$other');
        assert.equal(store.mutations.claim(profile, '$other', 0), true);
        assert.throws(() =>
            store.mutations.finish(
                profile,
                '$other',
                0,
                'REJECTED',
                'arbitrary private diagnostics',
            ),
        );
        store.mutations.finish(profile, '$other', 0, 'REJECTED', 'delete-window-expired');
        assert.equal(store.mutations.get(profile, '$other')!.reasons[0], 'delete-window-expired');
        assert.deepEqual(store.mutations.get(profile, '$other')!.states, ['REJECTED', 'CANCELLED']);
        assert.equal(store.mutations.claim(profile, '$other', 1), false);
        assert.equal(store.mutations.peek(profile), undefined);
        store.recoverInterrupted();
        assert.deepEqual(store.mutations.get(profile, '$edit')!.states, [
            'APPLIED',
            'OUTCOME_UNKNOWN',
        ]);
        store.close();
        const verified = new Database(path);
        verified.pragma('cipher_compatibility = 4');
        verified.pragma(`key = "x'${key.toString('hex')}'"`);
        assert.equal(verified.pragma('user_version', {simple: true}), 17);
        verified.close();
        store = new OutboxStore(path, key);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('schema 14 rejected mutations retain notices through failed acknowledgement and restart', async () => {
    const {MutationFailureNotices} = await import('../src/outbox/mutation-failure-notices.ts');
    const directory = mkdtempSync(join(tmpdir(), 'mutation-failure-'));
    const key = randomBytes(32),
        path = join(directory, 'outbox');
    let store = new OutboxStore(path, key);
    const operation: MutationOperation = {
        profile: 'SELF1234',
        owner: '@owner:invalid',
        room: '!room:invalid',
        chat: 'c:ABCD1234',
        event: '$change',
        target: '$original',
        commands: [1, 2, 3].map((part) => ({
            profile: 'SELF1234',
            chatId: 'c:ABCD1234',
            messageId: `m:${part.toString(16).padStart(16, '0')}`,
            action: 'edit',
            text: 'PRIVATE REPLACEMENT',
        })),
    };
    const ids: string[] = [];
    let allowed = false;
    const worker = () =>
        new MutationFailureNotices({
            profile: operation.profile,
            journal: store.mutations,
            ready: () => true,
            authorize: async (value) => {
                if (!allowed) throw new Error('Unauthorized');
                value.room = '!tampered:invalid';
            },
            send: async (id, room, content) => {
                ids.push(id);
                assert.equal(room, operation.room);
                assert.match(String(content.body), /part 2 of 3/);
                assert.match(String(content.body), /1 earlier part\(s\) were applied; 1 remaining/);
                assert(!JSON.stringify(content).includes('PRIVATE'));
            },
        });
    try {
        store.mutations.prepare(operation);
        assert(store.mutations.claim(operation.profile, operation.event, 0));
        store.mutations.finish(operation.profile, operation.event, 0, 'APPLIED');
        assert(store.mutations.claim(operation.profile, operation.event, 1));
        store.mutations.finish(
            operation.profile,
            operation.event,
            1,
            'REJECTED',
            'edit-window-expired',
        );
        store.close();
        const legacy = new Database(path);
        legacy.pragma('cipher_compatibility = 4');
        legacy.pragma(`key = "x'${key.toString('hex')}'"`);
        legacy.exec('DROP TABLE mutation_failure_notices; PRAGMA user_version=14;');
        legacy.close();
        store = new OutboxStore(path, key);
        assert.equal(store.mutations.pendingFailures(operation.profile, 10).length, 1);
        assert.equal(store.mutations.pendingFailures('OTHER123', 10).length, 0);
        await assert.rejects(worker().drain());
        assert.equal(ids.length, 0);
        allowed = true;
        store.mutations.acknowledgeFailure = () => {
            throw new Error('Synthetic acknowledgement failure');
        };
        await assert.rejects(worker().drain());
        store.close();
        store = new OutboxStore(path, key);
        assert.equal(await worker().drain(), 1);
        assert.equal(ids.length, 2);
        assert.equal(ids[0], ids[1]);
        store.close();
        store = new OutboxStore(path, key);
        assert.equal(await worker().drain(), 0);
        assert.deepEqual(store.mutations.get(operation.profile, operation.event)!.states, [
            'APPLIED',
            'REJECTED',
            'CANCELLED',
        ]);
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
