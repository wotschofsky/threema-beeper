import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {OutboxWorker} from '../src/outbox/worker.ts';
import {createBackendTextSender} from '../src/outbox/backend-sender.ts';
import {createRequestId} from '../src/outbox/request-id.ts';

await test('dispatch rechecks encryption, ownership and membership while preflight failures remain safely prepared', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-dispatch-'));
    const key = randomBytes(32),
        portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        botId = '@bot:invalid',
        room = '!room:invalid',
        chat = 'c:TEST1234';
    const requestId = createRequestId();
    const valid = [
        {type: 'm.room.encryption', state_key: '', content: {algorithm: 'm.megolm.v1.aes-sha2'}},
        {
            type: 'm.bridge',
            state_key: 'threema://bridge',
            sender: botId,
            content: {creator: owner, network: {id: profile}, channel: {id: chat}},
        },
        {type: 'm.room.member', state_key: owner, content: {membership: 'join'}},
    ];
    let state: any[] = structuredClone(valid),
        reads = 0,
        sends = 0,
        failRead = false,
        ready = true;
    let duringRead = () => {};
    const sender = createBackendTextSender(
        {
            sendText: async (_request, persist) => {
                sends++;
                const ids = ['m:ffffffffffffffff'];
                await persist(ids);
                return ids;
            },
        },
        {
            profile,
            owner,
            portals,
            bot: {
                userId: botId,
                underlyingClient: {
                    getRoomState: async () => {
                        reads++;
                        duringRead();
                        if (failRead) throw new Error('synthetic state outage');
                        return state;
                    },
                },
            },
        },
    );
    let now = 1_000_000;
    const worker = new OutboxWorker(outbox, sender, () => ready, {now: () => (now += 300_001)});
    try {
        portals.bind(profile, chat, room);
        outbox.prepare({
            requestId,
            profile,
            transactionId: 'txn',
            eventId: '$owner',
            roomId: room,
            sender: owner,
            chatId: chat,
            text: 'fixture',
        });
        for (const broken of [
            'encryption',
            'owner',
            'marker-sender',
            'network',
            'chat',
            'membership',
            'duplicate',
            'missing',
        ]) {
            state = structuredClone(valid);
            if (broken === 'encryption') state[0].content.algorithm = 'unexpected';
            if (broken === 'owner') state[1].content.creator = '@other:invalid';
            if (broken === 'marker-sender') state[1].sender = '@other:invalid';
            if (broken === 'network') state[1].content.network.id = 'OTHER123';
            if (broken === 'chat') state[1].content.channel.id = 'c:OTHER123';
            if (broken === 'membership') state[2].content.membership = 'leave';
            if (broken === 'duplicate') state.push(state[0]);
            if (broken === 'missing') state.pop();
            await assert.rejects(worker.flushOne());
            assert.equal(outbox.get(requestId)!.state, 'PREPARED');
            assert.equal(sends, 0);
        }
        state = structuredClone(valid);
        failRead = true;
        await assert.rejects(worker.flushOne(), /state outage/);
        assert.equal(outbox.get(requestId)!.state, 'PREPARED');
        failRead = false;
        duringRead = () => {
            ready = false;
        };
        assert.equal(await worker.flushOne(), false);
        assert.equal(outbox.get(requestId)!.state, 'PREPARED');
        ready = true;
        duringRead = () => {};
        assert.equal(await worker.flushOne(), true);
        assert.equal(sends, 1);
        assert.equal(outbox.get(requestId)!.state, 'SENT');
        assert.equal(reads, 11);
        const another = createRequestId();
        outbox.prepare({
            requestId: another,
            profile,
            transactionId: 'txn2',
            eventId: '$other',
            roomId: '!wrong:invalid',
            sender: owner,
            chatId: chat,
            text: 'fixture',
        });
        await assert.rejects(worker.flushOne(), /identity conflict/);
        assert.equal(reads, 11, 'Wrong mapped room is rejected before reading state');
        assert.equal(outbox.get(another)!.state, 'PREPARED');
    } finally {
        outbox.close();
        portals.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
