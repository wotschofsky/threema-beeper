import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {parseHistoryPage} from '../src/threema/history.ts';

const {normalizeNodeMessage} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
) as {
    normalizeNodeMessage(
        model: unknown,
        chatId: string,
        identity: string,
    ): Promise<Record<string, unknown>>;
};
const createdAt = new Date('2026-01-01T00:00:00Z');
const view = {
    id: 0xffffffffffffffffn,
    ordinal: 9007199254740991,
    direction: 0,
    createdAt,
    receivedAt: new Date('2026-01-01T00:00:01Z'),
    readAt: new Date('2026-01-01T00:00:03Z'),
    lastEditedAt: new Date('2026-01-01T00:00:02Z'),
    reactions: [{senderIdentity: 'TEST5678', reaction: '👍', reactionAt: createdAt}],
    raw: 'SECRET-PROTOCOL-BODY',
    encryptionKey: 'SECRET-MEDIA-KEY',
    fileData: {fileId: 'PRIVATE-PATH', encryptionKey: 'SECRET-FILE-KEY'},
};
function model(type: string, extra: Record<string, unknown> = {}, outbound = false) {
    return {
        type,
        ctx: outbound ? 1 : 0,
        view: {...view, ...extra, direction: outbound ? 1 : 0},
        controller: {sender: async () => ({get: () => ({view: {identity: 'TEST5678'}})})},
    };
}
function noSecrets(value: unknown) {
    parseHistoryPage({messages: [value]}, {chatId: 'c:TEST5678', limit: 1});
    const serialized = JSON.stringify(value, (_, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
    );
    assert.doesNotMatch(serialized, /SECRET|PRIVATE-PATH|encryptionKey|fileData|controller/);
}
await test('text normalization preserves IDs, replies, sender, edits, reactions and ordinal', async () => {
    const result = await normalizeNodeMessage(
        model('text', {text: 'Edited text', quotedMessageId: 0x0123456789abcdefn}),
        'c:TEST5678',
        'SELF1234',
    );
    assert.equal(result.messageId, 'm:ffffffffffffffff');
    assert.equal(result.replyToMessageId, 'm:efcdab8967452301');
    assert.equal(result.senderIdentity, 'TEST5678');
    assert.equal(result.ordinal, 9007199254740991n);
    assert.equal(result.editedAt, view.lastEditedAt);
    assert.deepEqual(result.reactions, [
        {senderIdentity: 'TEST5678', emoji: '👍', reactedAt: createdAt},
    ]);
    assert.deepEqual(result.content, {type: 'text', text: 'Edited text'});
    noSecrets(result);
});
await test('media metadata is preserved without exporting blob or local file keys', async () => {
    for (const type of ['image', 'video', 'audio', 'file']) {
        const result = await normalizeNodeMessage(
            model(
                type,
                {
                    mediaType: 'application/test',
                    fileName: 'attachment',
                    fileSize: 123,
                    caption: 'Caption',
                    blobId: new Uint8Array([0, 128, 255]),
                    thumbnailBlobId: new Uint8Array([1, 2]),
                    thumbnailMediaType: 'image/png',
                    dimensions: {width: 640, height: 480},
                    duration: 3.5,
                    sentAt: createdAt,
                    deliveredAt: createdAt,
                },
                true,
            ),
            'c:TEST5678',
            'SELF1234',
        );
        assert.equal(result.senderIdentity, 'SELF1234');
        assert.equal(result.direction, 'outbound');
        assert.equal(result.deliveredAt, createdAt);
        assert.deepEqual(result.content, {
            type,
            mimeType: 'application/test',
            fileName: 'attachment',
            byteSize: 123,
            caption: 'Caption',
            blobRef: 'b:0080ff',
            thumbnailRef: 'b:0102',
            thumbnailMimeType: 'image/png',
            dimensions: type === 'image' || type === 'video' ? {width: 640, height: 480} : undefined,
            durationSeconds: type === 'audio' || type === 'video' ? 3.5 : undefined,
        });
        noSecrets(result);
    }
});
await test('deleted and future message content do not retain the original body', async () => {
    for (const type of ['deleted', 'future-type']) {
        const result = await normalizeNodeMessage(
            model(type, {text: 'SECRET-DELETED-TEXT', deletedAt: createdAt}),
            'c:TEST5678',
            'SELF1234',
        );
        assert.equal(result.deletedAt, createdAt);
        assert.deepEqual(
            result.content,
            type === 'deleted'
                ? {type: 'deleted'}
                : {type: 'unsupported', description: 'Unsupported Threema message'},
        );
        noSecrets(result);
    }
});
await test('poll normalization retains choices and votes with canonical poll ID', async () => {
    const result = await normalizeNodeMessage(
        model('poll', {
            pollId: 1n,
            pollCreatorIdentity: 'TEST5678',
            description: 'Lunch?',
            pollState: 0,
            answerType: 0,
            announceType: 0,
            displayMode: 0,
            choicesType: 0,
            pollMessageType: 0,
            choices: [
                {
                    choiceId: 1,
                    description: 'Pizza',
                    sortKey: 0,
                    totalAmountVotes: 1,
                    votes: [{senderIdentity: 'SELF1234', selected: true}],
                },
            ],
        }),
        'c:TEST5678',
        'SELF1234',
    );
    const content = result.content as Record<string, unknown>;
    assert.equal(content.pollId, '0100000000000000');
    assert.deepEqual(content.choices, [
        {
            id: 1,
            description: 'Pizza',
            sortKey: 0,
            totalVotes: 1,
            votes: [{senderIdentity: 'SELF1234', selected: true}],
        },
    ]);
    noSecrets(result);
});
