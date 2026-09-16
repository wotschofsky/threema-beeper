import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {parseHistoryPage} from '../src/threema/history.ts';

type Cursor = {ordinal: string; messageId: string};
const {readNodeHistoryPage: readRawHistoryPage} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
) as {
    readNodeHistoryPage(
        handle: unknown,
        chatId: string,
        limit: number,
        after?: Cursor,
    ): Promise<{
        messages: {messageId: string; content: {text: string}}[];
        next?: Cursor;
    }>;
};
async function readNodeHistoryPage(handle: unknown, chatId: string, limit: number, after?: Cursor) {
    return parseHistoryPage(await readRawHistoryPage(handle, chatId, limit, after), {
        chatId,
        limit,
        after,
    });
}
const store = <T>(value: T) => ({get: () => value});
function fixture() {
    const message = (id: bigint, ordinal: number) =>
        store({
            type: 'text',
            ctx: 1,
            view: {
                id,
                ordinal,
                direction: 1,
                text: id.toString(),
                createdAt: new Date(0),
                reactions: [],
            },
            controller: {},
        });
    const messages = new Set([
        message(3n, 20),
        message(2n, 10),
        message(1n, 10),
        message(0xffffffffffffffffn, 30),
    ]);
    const conversation = store({
        controller: {
            receiver: async () => store({type: 0, view: {identity: 'TEST5678'}}),
            getAllMessages: async () => store(messages),
        },
    });
    return {
        messages,
        handle: {
            model: {
                user: {identity: 'SELF1234'},
                conversations: {getAll: async () => store(new Set([conversation]))},
            },
        },
    };
}
await test('history pages use stable ordinal/ID ordering and survive removal of the cursor message', async () => {
    const {handle, messages} = fixture();
    const first = await readNodeHistoryPage(handle, 'c:TEST5678', 1);
    assert.deepEqual(
        first.messages.map((row) => row.messageId),
        ['m:0100000000000000'],
    );
    assert.deepEqual(first.next, {ordinal: '10', messageId: 'm:0100000000000000'});
    for (const item of messages) if (item.get().view.id === 1n) messages.delete(item);
    const second = await readNodeHistoryPage(handle, 'c:TEST5678', 2, first.next);
    assert.deepEqual(
        second.messages.map((row) => row.messageId),
        ['m:0200000000000000', 'm:0300000000000000'],
    );
    const last = await readNodeHistoryPage(handle, 'c:TEST5678', 2, second.next);
    assert.deepEqual(
        last.messages.map((row) => row.messageId),
        ['m:ffffffffffffffff'],
    );
    assert.equal(last.next, undefined);
});
await test('history rejects invalid limits/cursors and distinguishes missing from empty conversations', async () => {
    const {handle, messages} = fixture();
    for (const limit of [0, -1, 501, 1.5, NaN])
        await assert.rejects(readNodeHistoryPage(handle, 'c:TEST5678', limit));
    await assert.rejects(
        readNodeHistoryPage(handle, 'c:TEST5678', 10, {
            ordinal: '9007199254740992',
            messageId: 'm:0000000000000000',
        }),
    );
    await assert.rejects(
        readNodeHistoryPage(handle, 'c:TEST5678', 10, {
            ordinal: '01',
            messageId: 'm:0000000000000000',
        }),
    );
    await assert.rejects(readNodeHistoryPage(handle, 'c:MISSING1', 10));
    messages.clear();
    assert.deepEqual(await readNodeHistoryPage(handle, 'c:TEST5678', 10), {
        messages: [],
        next: undefined,
    });
});

await test('native reader selects a bounded page from 100,000 unsorted model stores', async () => {
    const {handle, messages} = fixture();
    const template = messages.values().next().value!.get();
    messages.clear();
    const expected: {messageId: string; ordinal: number}[] = [];
    for (let n = 100000; n > 0; n--) {
        const id = 0xffff000000000000n + BigInt(n);
        const ordinal = n % 113;
        messages.add(store({...template, view: {...template.view, id, ordinal}}));
        const bytes = Buffer.alloc(8);
        bytes.writeBigUInt64LE(id);
        expected.push({messageId: 'm:' + bytes.toString('hex'), ordinal});
    }
    expected.sort((a, b) => a.ordinal - b.ordinal || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
    const cursor = expected[50000]!;
    const page = await readNodeHistoryPage(handle, 'c:TEST5678', 500, {
        ordinal: String(cursor.ordinal), messageId: cursor.messageId,
    });
    assert.deepEqual(page.messages.map(message => message.messageId), expected.slice(50001, 50501).map(message => message.messageId));
    const last = expected[50500]!;
    assert.deepEqual(page.next, {ordinal: String(last.ordinal), messageId: last.messageId});
});
