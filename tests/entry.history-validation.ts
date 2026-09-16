import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
    parseHistoryPage,
    parseHistoryRequest,
    type NormalizedNodeMessage,
} from '../src/threema/history.ts';

const request = {chatId: 'c:TEST1234', limit: 1};
const row: NormalizedNodeMessage = {
    messageId: 'm:ffffffffffffffff',
    chatId: request.chatId,
    direction: 'outbound',
    senderIdentity: 'SELF1234',
    createdAt: new Date(0),
    ordinal: 1n,
    reactions: [],
    content: {type: 'text', text: 'hello'},
};
await test('history IPC validates and detaches canonical dates/bigints and continuation', () => {
    const result = parseHistoryPage(
        {messages: [row], next: {ordinal: '1', messageId: row.messageId}},
        request,
    );
    assert.deepEqual(result.messages[0], row);
    assert.notEqual(result.messages[0], row);
    assert.notEqual(result.messages[0]!.createdAt, row.createdAt);
    assert.equal(typeof result.messages[0]!.ordinal, 'bigint');
});
await test('history IPC rejects invalid data, hidden keys and inconsistent pages', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => parseHistoryPage(cyclic, request), /exceeds limits/);
    for (const changed of [
        {...row, raw: 'secret'},
        {...row, ordinal: 1},
        {...row, createdAt: new Date(NaN)},
        {...row, chatId: 'c:OTHER123'},
        {...row, content: {type: 'deleted', text: 'old body'}},
        {
            ...row,
            content: {type: 'file', mimeType: 'text/plain', byteSize: 12, encryptionKey: 'secret'},
        },
        {...row, reactions: [{senderIdentity: 'invalid', emoji: '👍', reactedAt: new Date()}]},
    ])
        assert.throws(() => parseHistoryPage({messages: [changed]}, request));
    assert.throws(() => parseHistoryPage({messages: [row, row]}, {...request, limit: 2}));
    assert.throws(() =>
        parseHistoryPage(
            {messages: [row], next: {ordinal: '2', messageId: row.messageId}},
            request,
        ),
    );
    assert.throws(() =>
        parseHistoryPage({messages: [], next: {ordinal: '1', messageId: row.messageId}}, request),
    );
    assert.throws(() =>
        parseHistoryPage(
            {messages: [row]},
            {...request, after: {ordinal: '1', messageId: row.messageId}},
        ),
    );
    assert.throws(() =>
        parseHistoryRequest({...request, after: {ordinal: '1e3', messageId: row.messageId}}),
    );
});
