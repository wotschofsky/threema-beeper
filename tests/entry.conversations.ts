import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {parseConversations} from '../src/threema/conversations.ts';

const direct = {
    chatId: 'c:TEST1234',
    name: 'Friend',
    unreadCount: 3,
    archived: false,
    pinned: true,
    lastMessageId: 'm:ffffffffffffffff',
};
await test('upstream model adapter serializes high-bit IDs in little-endian order and resolves self-created groups', async () => {
    const {listNodeConversations} = createRequire(import.meta.url)(
        '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
    ) as {listNodeConversations(handle: unknown): Promise<unknown>};
    const store = <T>(value: T) => ({get: () => value});
    const conversation = (receiver: unknown, visibility: number) =>
        store({
            view: {unreadMessageCount: 2, visibility},
            controller: {
                receiver: async () => store(receiver),
                lastMessageStore: async () => store(store({view: {id: 0xfedcba9876543210n}})),
            },
        });
    const rows = await listNodeConversations({
        model: {
            user: {identity: 'TEST1234'},
            conversations: {
                getAll: async () =>
                    store(
                        new Set([
                            conversation(
                                {
                                    type: 2,
                                    view: {
                                        creator: 'me',
                                        groupId: 0x0123456789abcdefn,
                                        displayName: 'Group',
                                    },
                                },
                                1,
                            ),
                            conversation(
                                {type: 0, view: {identity: 'TEST5678', displayName: 'Contact'}},
                                2,
                            ),
                        ]),
                    ),
            },
        },
    });
    assert.deepEqual(parseConversations(rows), [
        {
            chatId: 'c:TEST5678',
            name: 'Contact',
            unreadCount: 2,
            archived: false,
            pinned: true,
            lastMessageId: 'm:1032547698badcfe',
        },
        {
            chatId: 'g:TEST1234:efcdab8967452301',
            name: 'Group',
            unreadCount: 2,
            archived: true,
            pinned: false,
            lastMessageId: 'm:1032547698badcfe',
        },
    ]);
});
await test('conversation boundary preserves fixed-width IDs and distinguishes group creators', () => {
    const groups = ['TEST1234', 'TEST5678'].map((creator) => ({
        ...direct,
        chatId: `g:${creator}:0000000000000080`,
    }));
    assert.deepEqual(parseConversations([direct, ...groups]), [direct, ...groups]);
    assert.equal(
        parseConversations([{...direct, internalKey: 'must not escape'}])[0]?.['chatId'],
        direct.chatId,
    );
    assert.equal(
        'internalKey' in parseConversations([{...direct, internalKey: 'must not escape'}])[0]!,
        false,
    );
});
await test('conversation boundary rejects duplicate, malformed and unsafe records', () => {
    assert.throws(() => parseConversations([direct, direct]));
    for (const change of [
        {chatId: 'g:TEST1234:1'},
        {chatId: 'c:test1234'},
        {lastMessageId: 9007199254740992},
        {lastMessageId: 'm:FFFFFFFFFFFFFFFF'},
        {unreadCount: -1},
        {unreadCount: NaN},
        {archived: true},
        {name: null},
    ])
        assert.throws(() => parseConversations([{...direct, ...change}]));
});
