import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCipheriv, createHash, randomBytes} from 'node:crypto';
import {mkdtemp, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {
    getRequestFn,
    setRequestFn,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';
import {createFilePreparation} from '../src/media/file-preparation.ts';
import {MediaDispatcher} from '../src/outbox/media-dispatcher.ts';
import {OutboxStore} from '../src/outbox/store.ts';
import {createRequestId} from '../src/outbox/request-id.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';
await test('encrypted download streams to worker preparation and durable file dispatch without a plaintext spool', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'file-preparation-')),
        key = randomBytes(32),
        iv = randomBytes(16);
    const store = new OutboxStore(join(directory, 'outbox'), key),
        original = getRequestFn();
    const plain = Buffer.alloc(150000, 0x41),
        cipher = createCipheriv('aes-256-ctr', key, iv),
        encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const request: MediaRequest = {
        id: createRequestId(),
        profile: 'SELF1234',
        event: '$file',
        room: '!room:invalid',
        owner: '@owner:invalid',
        transaction: 'transaction',
        media: {
            chat: 'c:ABCD1234',
            kind: 'm.file',
            filename: 'fixture.bin',
            caption: 'Caption',
            mimeType: 'application/octet-stream',
            bytes: plain.length,
            file: {
                url: 'mxc://media.invalid/id',
                v: 'v2',
                key: {
                    kty: 'oct',
                    alg: 'A256CTR',
                    key_ops: ['decrypt'],
                    k: key.toString('base64url'),
                },
                iv: iv.toString('base64'),
                hashes: {sha256: createHash('sha256').update(encrypted).digest('base64')},
            },
        },
    };
    let sniffed = false,
        prepared = false,
        added = 0,
        downloads = 0,
        maximum = 200000;
    try {
        setRequestFn(async () => {
            downloads++;
            return {
                statusCode: 200,
                headers: {'content-length': String(encrypted.length)},
                body: Readable.from([encrypted]),
            };
        });
        const abort = new AbortController();
        let discovery: Promise<number> | undefined;
        const prepare = createFilePreparation({
            signal: abort.signal,
            client: {
                homeserverUrl: 'https://matrix.invalid',
                accessToken: 'synthetic',
                doesServerSupportVersion: async () => true,
            },
            userId: '@bot:invalid',
            directory,
            maximumBytes: async () => discovery ?? maximum,
            verifyMime: async (header) => {
                assert.deepEqual(header, plain.subarray(0, 4096));
                sniffed = true;
            },
            backend: {
                prepareFile: async (input, source) => {
                    assert.equal(sniffed, true);
                    assert.equal(input.bytes, plain.length);
                    const hash = createHash('sha256');
                    for await (const part of source) hash.update(part);
                    assert.equal(
                        hash.digest('hex'),
                        createHash('sha256').update(plain).digest('hex'),
                    );
                    prepared = true;
                    return 'a'.repeat(64);
                },
                discardPreparedFile: async () => {
                    assert.fail('A successful send must retain model-owned file data');
                },
            },
        });
        store.media.prepare(request);
        const dispatcher = new MediaDispatcher({
            profile: request.profile,
            journal: store.media,
            ready: () => true,
            authorize: async () => {},
            prepare,
            backend: {
                sendPreparedFile: async (input, persist) => {
                    assert.equal(prepared, true);
                    assert.equal(input.caption, 'Caption');
                    assert.equal(
                        (await readdir(directory)).some((name) =>
                            name.startsWith('outbound-attachment-'),
                        ),
                        false,
                    );
                    const ids = ['m:0100000000000000'];
                    await persist(ids);
                    assert.deepEqual(store.media.get(request.profile, request.event)!.ids, ids);
                    added++;
                    return ids;
                },
            },
        });
        assert.equal(await dispatcher.drain(), 1);
        assert.equal(added, 1);
        assert.equal(store.media.get(request.profile, request.event)!.state, 'SENT');
        maximum = 1;
        await assert.rejects(prepare({...request, id: createRequestId()}));
        assert.equal(downloads, 1);
        let release!: (value: number) => void;
        discovery = new Promise((resolve) => {
            release = resolve;
        });
        const interrupted = prepare({...request, id: createRequestId()});
        abort.abort();
        await assert.rejects(interrupted);
        release(200000);
        await Promise.resolve();
        assert.equal(downloads, 1, 'late discovery after shutdown cannot start another download');
    } finally {
        setRequestFn(original);
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
