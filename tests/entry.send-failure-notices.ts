import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import {SendFailureNotices} from '../src/outbox/send-failure-notices.ts';
for (const acceptedBeforeRestart of [false, true]) {
    await test(`send failure notices survive restart without repeating the original (accepted=${acceptedBeforeRestart})`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'send-notices-')),
            key = randomBytes(32);
        let outbox = new OutboxStore(join(dir, 'outbox'), key),
            portals = new PortalStore(join(dir, 'portals'), key);
        const request = {
            requestId: createRequestId(),
            profile: 'SELF1234',
            transactionId: 'test',
            eventId: '$original',
            roomId: '!test:invalid',
            sender: '@owner:invalid',
            chatId: 'c:ECHOECHO',
            text: 'private original',
        };
        let authorized = false,
            lose = true;
        const attempts: {id: string; content: Record<string, any>}[] = [];
        const worker = () =>
            new SendFailureNotices({
                profile: request.profile,
                outbox,
                portals,
                ready: () => true,
                authorize: async () => {
                    if (!authorized) throw Error('forbidden');
                },
                send: async (id, room, content) => {
                    attempts.push({id, content});
                    portals.prepareOperation({
                        id,
                        room,
                        sender: request.sender,
                        digest: 'test',
                        ciphertext: '{}',
                    });
                    if (lose) throw Error('lost response');
                    portals.completeOperation(id, '$notice');
                },
            });
        try {
            outbox.prepare(request);
            outbox.claim(request.requestId);
            if (acceptedBeforeRestart) {
                const ids = ['m:0100000000000000'];
                outbox.recordIds(request.requestId, ids);
                outbox.sent(request.requestId, ids);
                outbox.close();
                outbox = new OutboxStore(join(dir, 'outbox'), key);
                outbox.recoverInterrupted();
            } else outbox.unknown(request.requestId);
            await assert.rejects(worker().drain());
            assert.equal(attempts.length, 0);
            authorized = true;
            await assert.rejects(worker().drain());
            outbox.close();
            portals.close();
            outbox = new OutboxStore(join(dir, 'outbox'), key);
            portals = new PortalStore(join(dir, 'portals'), key);
            lose = false;
            assert.equal(await worker().drain(), 1);
            assert.deepEqual(attempts[0], attempts[1]);
            assert.equal(await worker().drain(), 0);
            assert.match(attempts[1]!.content.body, /Check Threema on your phone/);
            assert.equal(
                attempts[1]!.content['m.relates_to']['m.in_reply_to'].event_id,
                '$original',
            );
            assert.equal(outbox.get(request.requestId)?.state, 'OUTCOME_UNKNOWN');
            assert.ok(!JSON.stringify(attempts).includes('private original'));
        } finally {
            outbox.close();
            portals.close();
            key.fill(0);
            rmSync(dir, {recursive: true, force: true});
        }
    });
}

await test('failure notices eventually cover text and attachments beyond the first hundred pending rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notice-backlog-')),
        key = randomBytes(32);
    const outbox = new OutboxStore(join(dir, 'outbox'), key),
        portals = new PortalStore(join(dir, 'portals'), key);
    const profile = 'SELF1234',
        room = '!test:invalid',
        owner = '@owner:invalid';
    const seen = new Set<string>();
    try {
        for (let index = 0; index < 103; index++) {
            const id = createRequestId(),
                chat = 'c:' + index.toString().padStart(8, '0');
            outbox.prepare({
                requestId: id,
                profile,
                transactionId: 't' + index,
                eventId: '$t' + index,
                roomId: room,
                sender: owner,
                chatId: chat,
                text: 'synthetic',
            });
            for (let n = 0; n < 3; n++) outbox.deferPreflight(id, Date.now() + 300000);
            const event = '$m' + index;
            outbox.media.prepare({
                id: createRequestId(),
                profile,
                event,
                room,
                owner,
                transaction: 'm' + index,
                media: {
                    chat,
                    kind: 'm.file',
                    filename: 'synthetic.bin',
                    mimeType: 'application/octet-stream',
                    bytes: 1,
                    file: {
                        url: 'mxc://invalid/file',
                        v: 'v2',
                        key: {
                            kty: 'oct',
                            alg: 'A256CTR',
                            key_ops: ['decrypt'],
                            k: Buffer.alloc(32).toString('base64url'),
                        },
                        iv: Buffer.alloc(16).toString('base64'),
                        hashes: {sha256: Buffer.alloc(32).toString('base64')},
                    },
                },
            });
            for (let n = 0; n < 3; n++) outbox.media.deferPreparation(profile, event);
        }
        const worker = new SendFailureNotices({
            profile,
            outbox,
            portals,
            ready: () => true,
            authorize: async () => {},
            send: async (id, target, content) => {
                const event = (content['m.relates_to'] as {'m.in_reply_to': {event_id: string}})[
                    'm.in_reply_to'
                ].event_id;
                assert(!seen.has(event), 'Acknowledged notice repeated');
                seen.add(event);
                portals.prepareOperation({
                    id,
                    room: target,
                    sender: owner,
                    digest: 'synthetic',
                    ciphertext: '{}',
                });
                portals.completeOperation(id, '$notice' + seen.size);
            },
        });
        for (let n = 0; n < 12; n++) assert((await worker.drain(40)) <= 40);
        assert.equal(
            seen.size,
            206,
            'Later failures must not be hidden behind persistent earlier rows',
        );
        assert(seen.has('$t102') && seen.has('$m102'));
        for (let n = 0; n < 12; n++) assert.equal(await worker.drain(40), 0);
    } finally {
        outbox.close();
        portals.close();
        key.fill(0);
        rmSync(dir, {recursive: true, force: true});
    }
});
