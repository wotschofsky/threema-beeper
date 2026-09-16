import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {StatusDelivery} from '../src/matrix/status-delivery.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('status evidence and monotonic receipts survive lost receipt replies without guessing group readers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-status-'));
    const key = randomBytes(32),
        filename = join(directory, 'portals.sqlite');
    let store = new PortalStore(filename, key);
    let delivery = new StatusDelivery(store);
    const profile = 'SELF1234',
        chat = 'c:TEST1234',
        room = '!room:matrix.invalid';
    const message: NormalizedNodeMessage = {
        chatId: chat,
        messageId: 'm:0200000000000000',
        direction: 'outbound',
        senderIdentity: profile,
        createdAt: new Date(0),
        ordinal: 2n,
        reactions: [],
        content: {type: 'text', text: 'A'},
        sentAt: new Date(1000),
    };
    function map(value: NormalizedNodeMessage, event: string) {
        if (!store.get(profile, value.chatId))
            store.bind(
                profile,
                value.chatId,
                value.chatId === chat ? room : '!group:matrix.invalid',
            );
        const target = store.get(profile, value.chatId)!;
        const id = `seed-${value.chatId}-${value.messageId}`;
        store.prepareOperation({
            id,
            sender: '@ghost:matrix.invalid',
            room: target,
            digest: 'synthetic',
            ciphertext: 'synthetic',
        });
        store.completeOperation(id, event);
        store.prepareProjection({
            id,
            profile,
            chat: value.chatId,
            message: value.messageId,
            room: target,
            sender: '@ghost:matrix.invalid',
            fingerprint: id,
            digest: id,
            root: null,
            content: '{}',
        });
        store.finishProjection(id, event);
    }
    const statuses: Record<string, any>[] = [];
    const receipts: {reader: string; target: string}[] = [];
    let lost = true;
    const sender = {
        send: async (
            _id: string,
            _room: string,
            type: string,
            content: Record<string, unknown>,
        ) => {
            assert.equal(type, 'com.threema.message_status');
            statuses.push(content);
            return `$status${statuses.length}`;
        },
    };
    const reader = async (identity: string) => {
        const client = new MatrixClient('https://matrix.invalid', 'synthetic');
        client.doRequest = async (method, path, _query, body): Promise<any> => {
            assert.equal(method, 'POST');
            assert.deepEqual(body, {});
            receipts.push({
                reader: identity,
                target: decodeURIComponent(path.split('/receipt/m.read/')[1]!),
            });
            if (lost) {
                lost = false;
                throw new Error('synthetic lost receipt reply');
            }
            return {};
        };
        return client;
    };
    const apply = (value: NormalizedNodeMessage, id: string) =>
        delivery.apply(profile, value, id, sender, reader);
    try {
        map(message, '$original');
        await apply(message, 'sent');
        assert.equal(statuses[0]!.status, 'sent');
        assert.equal(receipts.length, 0);
        const delivered = {...message, deliveredAt: new Date(2000)};
        await apply(delivered, 'delivered');
        assert.equal(statuses[1]!.status, 'delivered');
        const read = {...delivered, readAt: new Date(3000)};
        await assert.rejects(apply(read, 'read'), /lost receipt/);
        assert.equal(statuses[2]!.status, 'read');
        assert.equal(store.receiptPosition(profile, chat, 'TEST1234'), undefined);
        store.close();
        store = new PortalStore(filename, key);
        delivery = new StatusDelivery(store);
        await apply(read, 'read');
        assert.equal(statuses.length, 3);
        assert.deepEqual(receipts, [
            {reader: 'TEST1234', target: '$original'},
            {reader: 'TEST1234', target: '$original'},
        ]);
        await apply(message, 'stale');
        assert.equal(statuses.length, 3);
        assert.equal(receipts.length, 2);
        const older = {...read, messageId: 'm:0100000000000000', ordinal: 1n};
        map(older, '$older');
        await apply(older, 'older');
        assert.equal(receipts.length, 2);
        const inbound = {
            ...read,
            direction: 'inbound' as const,
            senderIdentity: 'TEST1234',
            messageId: 'm:0300000000000000',
            ordinal: 3n,
        };
        map(inbound, '$inbound');
        await apply(inbound, 'inbound');
        assert.deepEqual(receipts.at(-1), {reader: profile, target: '$inbound'});
        assert.deepEqual(statuses.at(-1)!.timestamps, {readAt: 3000});
        const group = {...read, chatId: 'g:SELF1234:0100000000000000'};
        map(group, '$group');
        await apply(group, 'group');
        assert.equal(statuses.at(-1)!.status, 'read');
        assert.equal(receipts.length, 3);
        assert.equal(store.receiptPosition(profile, chat, 'TEST1234')?.ordinal, '2');
    } finally {
        store.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
