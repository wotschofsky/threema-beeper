import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import Database from '../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';
import {MessageJournal} from '../src/threema/message-journal.ts';
import {
    encodeMetadata,
    decodeMetadata,
    type ProfileMetadata,
} from '../src/threema/metadata-codec.ts';

const metadata: ProfileMetadata = {
    directory: {
        contacts: [],
        groups: [
            {
                groupKey: 'g:SELF1234:0000000000000080',
                creatorIdentity: 'SELF1234',
                groupId: 0x8000000000000000n,
                name: 'Private group',
                memberIdentities: ['SELF1234'],
                userState: 0,
            },
        ],
    },
    chats: [
        {
            chatId: 'g:SELF1234:0000000000000080',
            name: 'Private group',
            unreadCount: 0,
            archived: false,
            pinned: false,
        },
    ],
};
await test('metadata codec preserves high-bit group IDs and rejects noncanonical encodings', () => {
    const encoded = encodeMetadata(metadata);
    assert.deepEqual(decodeMetadata(encoded).directory, metadata.directory);
    assert.throws(() =>
        decodeMetadata(encoded.replace('"9223372036854775808"', '9223372036854775808')),
    );
    assert.throws(() => decodeMetadata(encoded.replace('"version":1', '"version":9')));
});
await test('profile metadata and staged messages publish together and stale acknowledgement cannot clear a newer epoch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-profile-metadata-'));
    const filename = join(directory, 'journal.sqlite');
    const key = randomBytes(32);
    let journal = new MessageJournal(filename, key, 'SELF1234');
    try {
        const chat = metadata.chats[0]!;
        const token = journal.beginReconciliation(chat.chatId);
        journal.stage(token, 'snapshot', {
            chatId: chat.chatId,
            messageId: 'm:0100000000000000',
            senderIdentity: 'SELF1234',
            direction: 'outbound',
            createdAt: new Date(0),
            ordinal: 1n,
            reactions: [],
            content: {type: 'text', text: 'history'},
        });
        assert.equal(journal.metadata(), undefined);
        assert.equal(journal.pending().length, 0);
        assert.throws(() => journal.commitProfile([], metadata));
        assert.equal(journal.metadata(), undefined);
        assert.equal(journal.pending().length, 0);
        const fault = new Database(filename);
        try {
            fault.pragma('cipher_compatibility = 4');
            fault.pragma(`key = "x'${key.toString('hex')}'"`);
            fault.exec(
                "CREATE TRIGGER fail_metadata BEFORE INSERT ON profile_metadata BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END",
            );
            assert.throws(() => journal.commitProfile([token], metadata));
            assert.equal(
                journal.pending().length,
                0,
                'Message publication must roll back if metadata publication fails',
            );
            assert.equal(journal.metadata(), undefined);
            fault.exec('DROP TRIGGER fail_metadata');
        } finally {
            fault.close();
        }
        const first = journal.commitProfile([token], metadata);
        assert.equal(journal.pending().length, 1);
        assert.equal(journal.metadata(true)!.epoch, first);
        journal.close();
        journal = new MessageJournal(filename, key, 'SELF1234');
        assert.deepEqual(journal.metadata()!.directory, metadata.directory);
        const secondToken = journal.beginReconciliation(chat.chatId);
        const second = journal.commitProfile([secondToken], metadata);
        journal.acknowledgeMetadata(first);
        assert.equal(journal.metadata(true)!.epoch, second);
        journal.acknowledgeMetadata(second);
        assert.equal(journal.metadata(true), undefined);
        assert.equal(journal.metadata()!.epoch, second);
    } finally {
        journal.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('profile publication preserves observed cross-chat live order across batches and restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-profile-order-'));
    const filename = join(directory, 'journal.sqlite');
    const key = randomBytes(32);
    let journal = new MessageJournal(filename, key, 'SELF1234');
    try {
        const chats = ['c:TEST1234', 'c:TEST5678'].map((chatId) => ({
            chatId,
            name: chatId,
            unreadCount: 0,
            archived: false,
            pinned: false,
        }));
        const tokens = chats.map((chat) => journal.beginReconciliation(chat.chatId));
        const unrelated = journal.beginReconciliation('c:OTHER123');
        const stage = (token: string, chatId: string, phase: 'snapshot' | 'live', text: string) =>
            journal.stage(token, phase, {
                chatId,
                messageId: 'm:0100000000000000',
                senderIdentity: 'SELF1234',
                direction: 'outbound',
                createdAt: new Date(0),
                ordinal: 1n,
                reactions: [],
                content: {type: 'text', text},
            });
        // Arrival order opposes the profile's chat enumeration order and crosses row batches.
        const expected = ['snapshot 0', 'snapshot 1'];
        for (let i = 0; i < 40; i++) {
            const chat = (i + 1) % 2;
            stage(tokens[chat]!, chats[chat]!.chatId, 'live', `live ${i}`);
            expected.push(`live ${i}`);
        }
        stage(unrelated, 'c:OTHER123', 'live', 'unrelated');
        for (let i = 0; i < 2; i++)
            stage(tokens[i]!, chats[i]!.chatId, 'snapshot', `snapshot ${i}`);
        journal.commitProfile(tokens, {directory: {contacts: [], groups: []}, chats});
        journal.close();
        journal = new MessageJournal(filename, key, 'SELF1234');
        assert.deepEqual(
            journal.pending().map(({message}) => message.content),
            expected.map((text) => ({type: 'text', text})),
        );
        // Publishing selected chats must leave unrelated staging untouched.
        journal.commitReconciliation(unrelated);
        assert.deepEqual(journal.pending().at(-1)!.message.content, {
            type: 'text',
            text: 'unrelated',
        });
    } finally {
        journal.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
