import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {
    appendFileSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {
    OlmMachine,
    UserId,
    DeviceId,
    RoomId,
    EncryptionSettings,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/index.js';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {EncryptedSender} from '../src/matrix/encrypted-sender.ts';
import {StatusDelivery} from '../src/matrix/status-delivery.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {OutboxWorker} from '../src/outbox/worker.ts';
import {MediaDispatcher} from '../src/outbox/media-dispatcher.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

const profile = 'SELF1234',
    chat = 'c:TEST1234',
    room = '!status:invalid',
    owner = '@owner:invalid',
    sender = '@bot:invalid';
const requestId = '01900000-0000-7000-8000-000000000001',
    messageId = 'm:0100000000000000';
const points = [
    'before-status',
    'before-put',
    'accepted',
    'encrypted-result',
    'status-saved',
] as const;
const kinds = ['text', 'file', 'image', 'audio', 'video'] as const;
type Kind = (typeof kinds)[number];
const message: NormalizedNodeMessage = {
    chatId: chat,
    messageId,
    direction: 'outbound',
    senderIdentity: profile,
    createdAt: new Date(0),
    ordinal: 1n,
    reactions: [],
    content: {type: 'text', text: 'fixture'},
    sentAt: new Date(1000),
};
function fixture(outbox: OutboxStore, kind: Kind) {
    if (kind === 'text') {
        const request = {
            requestId,
            profile,
            transactionId: 'fixture',
            eventId: '$original',
            roomId: room,
            sender: owner,
            chatId: chat,
            text: 'fixture',
        };
        return {
            prepare: () => outbox.prepare(request),
            sent: () => {
                outbox.claim(requestId);
                outbox.recordIds(requestId, [messageId]);
                outbox.sent(requestId, [messageId]);
            },
            state: () => outbox.get(requestId)?.state,
        };
    }
    const request: MediaRequest = {
        id: requestId,
        profile,
        transaction: 'fixture',
        event: '$original',
        room,
        owner,
        media: {
            chat,
            kind: `m.${kind}`,
            filename: 'fixture.bin',
            mimeType: 'application/octet-stream',
            bytes: 12,
            file: {
                url: 'mxc://invalid/fixture',
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
    };
    return {
        prepare: () => outbox.media.prepare(request),
        sent: () => {
            outbox.media.claim(profile, '$original');
            if (kind === 'image')
                outbox.media.recordImageProjection(profile, '$original', {
                    kind: 'image',
                    fileName: 'fixture.png',
                    mediaType: 'image/png',
                    width: 2,
                    height: 2,
                    bytes: 12,
                    thumbnailMediaType: 'image/png',
                    thumbnailWidth: 1,
                    thumbnailHeight: 1,
                    thumbnailBytes: 6,
                });
            const fallback = {
                kind: 'file' as const,
                fileName: 'fixture.bin',
                mediaType: 'application/octet-stream',
                bytes: 12,
            };
            if (kind === 'audio')
                outbox.media.recordAudioProjection(profile, '$original', fallback);
            if (kind === 'video')
                outbox.media.recordVideoProjection(profile, '$original', fallback);
            outbox.media.recordIds(profile, '$original', [messageId]);
            outbox.media.sent(profile, '$original', [messageId]);
        },
        state: () => outbox.media.get(profile, '$original')?.state,
    };
}
function persist(path: string, body: string) {
    const fd = openSync(path, 'a', 0o600);
    try {
        appendFileSync(fd, body);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}
async function deliver(
    directory: string,
    key: Buffer,
    store: PortalStore,
    checkpoint: (point: string) => Promise<void>,
    kind: Kind,
) {
    const machine = await OlmMachine.initialize(
        new UserId(sender),
        new DeviceId('STATUS_FIXTURE'),
        join(directory, 'crypto'),
        key.toString('base64'),
    );
    try {
        await machine.shareRoomKey(new RoomId(room), [], new EncryptionSettings());
        const client = new MatrixClient('https://matrix.invalid', 'synthetic');
        Object.defineProperty(client, 'crypto', {
            value: {
                encryptRoomEvent: async (r: string, type: string, content: unknown) => {
                    const encrypted = JSON.parse(
                        await machine.encryptRoomEvent(
                            new RoomId(r),
                            type,
                            JSON.stringify(content),
                        ),
                    );
                    persist(join(directory, 'encryptions'), 'encrypted\n');
                    return {
                        ...encrypted,
                        sender_key: machine.identityKeys.curve25519.toBase64(),
                        device_id: 'STATUS_FIXTURE',
                    };
                },
            },
        });
        client.getRoomStateEventContent = async () => ({algorithm: 'm.megolm.v1.aes-sha2'});
        client.doRequest = async (method, path, _query, body): Promise<any> => {
            assert.equal(method, 'PUT');
            assert(path.includes('/send/m.room.encrypted/'));
            const wire = JSON.stringify({path, body});
            assert.equal(
                store.operation(path.split('/').at(-1)!)?.ciphertext,
                JSON.stringify(body),
            );
            await checkpoint('before-put');
            if (existsSync(join(directory, 'accepted')))
                assert.equal(readFileSync(join(directory, 'accepted'), 'utf8'), wire);
            else persist(join(directory, 'accepted'), wire);
            persist(join(directory, 'attempts'), 'put\n');
            await checkpoint('accepted');
            return {event_id: '$status'};
        };
        const encrypted = new EncryptedSender(
            {userId: sender, underlyingClient: client, enableEncryption: async () => {}},
            store,
        );
        const status = new StatusDelivery(store);
        await checkpoint('before-status');
        await status.apply(
            profile,
            {
                ...message,
                content:
                    kind === 'text'
                        ? message.content
                        : {
                              type: kind,
                              fileName: 'fixture.bin',
                              mimeType: 'application/octet-stream',
                              byteSize: 12,
                          },
            },
            'durable-status-operation',
            {
                send: async (...args) => {
                    const id = await encrypted.send(...args);
                    await checkpoint('encrypted-result');
                    return id;
                },
            },
            async () => {
                throw Error('Sent status must not create a read receipt');
            },
        );
        await checkpoint('status-saved');
        const wire = JSON.parse(readFileSync(join(directory, 'accepted'), 'utf8'));
        const decrypted = JSON.parse(
            (
                await machine.decryptRoomEvent(
                    JSON.stringify({
                        type: 'm.room.encrypted',
                        event_id: '$status',
                        sender,
                        origin_server_ts: 1,
                        content: wire.body,
                    }),
                    new RoomId(room),
                )
            ).event,
        );
        assert.equal(decrypted.type, 'com.threema.message_status');
        assert.equal(decrypted.content.status, 'sent');
        assert.deepEqual(decrypted.content.timestamps, {sentAt: 1000});
        assert.equal(decrypted.content['m.relates_to'].event_id, '$original');
    } finally {
        machine.close();
    }
}
if (process.argv[2] === '--child') {
    const directory = process.argv[3]!,
        point = process.argv[4]!,
        key = readFileSync(join(directory, 'key'));
    const store = new PortalStore(join(directory, 'portals'), key);
    await deliver(
        directory,
        key,
        store,
        async (name) => {
            if (name === point) {
                process.send?.({point});
                await new Promise<void>(() => {
                    setInterval(() => {}, 1000);
                });
            }
        },
        process.argv[5] as Kind,
    );
    throw Error('Checkpoint not reached');
} else
    for (const kind of kinds)
        await test(
            `SIGKILL encrypted ${kind} status retries without resending to Threema`,
            {timeout: 90_000},
            async (context) => {
                for (const point of points) {
                    const directory = mkdtempSync(join(tmpdir(), 'status-kill-')),
                        key = randomBytes(32);
                    let store: PortalStore | undefined,
                        outbox: OutboxStore | undefined,
                        child: ReturnType<typeof fork> | undefined,
                        exited: Promise<unknown[]> | undefined;
                    try {
                        writeFileSync(join(directory, 'key'), key, {mode: 0o400, flag: 'wx'});
                        store = new PortalStore(join(directory, 'portals'), key);
                        store.bind(profile, chat, room);
                        store.bindOwnerEcho({
                            profile,
                            chat,
                            room,
                            message: messageId,
                            sender: owner,
                            root: '$original',
                            latest: '$original',
                            digest: 'fixture',
                        });
                        store.close();
                        store = undefined;
                        outbox = new OutboxStore(join(directory, 'outbox'), key);
                        const initial = fixture(outbox, kind);
                        initial.prepare();
                        initial.sent();
                        outbox.close();
                        outbox = undefined;
                        child = fork(
                            fileURLToPath(import.meta.url),
                            ['--child', directory, point, kind],
                            {
                                execPath: process.execPath,
                                stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                            },
                        );
                        exited = once(child, 'exit');
                        const [reported] = await Promise.race([
                            once(child, 'message', {signal: context.signal}),
                            exited.then(() => {
                                throw Error('Child exited before ' + point);
                            }),
                        ]);
                        assert.deepEqual(reported, {point});
                        assert(child.kill('SIGKILL'));
                        assert.equal((await exited)[1], 'SIGKILL');
                        outbox = new OutboxStore(join(directory, 'outbox'), key);
                        outbox.recoverInterrupted();
                        const recovered = fixture(outbox, kind);
                        recovered.prepare();
                        // The send return alone is not confirmation; this status-only fixture has not observed an echo.
                        assert.equal(recovered.state(), 'OUTCOME_UNKNOWN');
                        let sends = 0;
                        const worker = new OutboxWorker(
                            outbox,
                            {
                                send: async () => {
                                    sends++;
                                    throw Error('Must not resend');
                                },
                            },
                            () => true,
                        );
                        const media = new MediaDispatcher({
                            profile,
                            journal: outbox.media,
                            ready: () => true,
                            authorize: async () => {},
                            prepare: async () => {
                                sends++;
                                throw Error('Must not prepare completed media');
                            },
                            backend: {
                                sendPreparedFile: async () => {
                                    sends++;
                                    throw Error('Must not resend media');
                                },
                            },
                        });
                        assert.equal(await worker.flushOne(), false);
                        assert.equal(await media.drain(), 0);
                        store = new PortalStore(join(directory, 'portals'), key);
                        await deliver(directory, key, store, async () => {}, kind);
                        await deliver(directory, key, store, async () => {}, kind);
                        assert.equal(await worker.flushOne(), false);
                        assert.equal(await media.drain(), 0);
                        assert.equal(sends, 0);
                        assert.equal(
                            readFileSync(join(directory, 'encryptions'), 'utf8'),
                            'encrypted\n',
                        );
                        assert.equal(
                            readFileSync(join(directory, 'attempts'), 'utf8'),
                            point === 'accepted' ? 'put\nput\n' : 'put\n',
                        );
                        assert.deepEqual(
                            JSON.parse(store.messageStatus(profile, chat, messageId)!),
                            {
                                sentAt: 1000,
                            },
                        );
                        assert.equal(
                            store.messageMapping(profile, chat, messageId)?.root,
                            '$original',
                        );
                        context.diagnostic(
                            `${kind}/${point}: native Megolm status recovered; no second Threema send`,
                        );
                    } finally {
                        if (child && child.exitCode === null && child.signalCode === null)
                            child.kill('SIGKILL');
                        if (exited) await exited;
                        store?.close();
                        outbox?.close();
                        key.fill(0);
                        rmSync(directory, {recursive: true, force: true});
                    }
                }
            },
        );
