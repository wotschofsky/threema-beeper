import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {createBackendMediaRenderer} from '../src/media/backend-renderer.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';

await test('backend renderer uses lazy controller streams and real MIME detection before encrypted upload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-backend-renderer-'));
    const key = randomBytes(32),
        store = new PortalStore(join(directory, 'store.sqlite'), key);
    const bytes = Buffer.from('%PDF-1.7\nfixture');
    let streams = 0,
        uploads = 0,
        enabled = false;
    const client = new MatrixClient('https://matrix.invalid', 'synthetic');
    client.doRequest = async (_method, _path, _query, body): Promise<any> => {
        if (_path.endsWith('/versions')) return {versions: ['v1.11']};
        if (_path.endsWith('/config')) return {'m.upload.size': 512};
        assert.ok(enabled);
        assert.ok(body instanceof Readable);
        for await (const _chunk of body) {
        }
        uploads++;
        return {content_uri: 'mxc://matrix.invalid/pdf'};
    };
    const info = {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mimeType: 'application/pdf',
    };
    const backend = {
        mediaLimits: async () => ({maximumBytes: 1024}),
        mediaInfo: async () => info,
        mediaStream: async () => {
            streams++;
            return Readable.from([bytes]);
        },
    };
    try {
        const renderer = await createBackendMediaRenderer({
            profile: 'SELF1234',
            backend,
            store,
            temporaryDirectory: directory,
            bot: {
                underlyingClient: client,
                enableEncryption: async () => {
                    enabled = true;
                },
            },
            maximumBytes: 1024,
        });
        const message: NormalizedNodeMessage = {
            chatId: 'c:TEST1234',
            messageId: 'm:0100000000000000',
            direction: 'inbound',
            senderIdentity: 'TEST1234',
            createdAt: new Date(0),
            ordinal: 1n,
            reactions: [],
            content: {
                type: 'file',
                mimeType: 'application/pdf',
                byteSize: bytes.length,
                fileName: 'document.pdf',
            },
        };
        const rendered = await renderer.render(message);
        assert.equal(rendered.msgtype, 'm.file');
        assert.equal(uploads, 1);
        assert.equal(streams, 1);
        await renderer.render(message);
        assert.equal(uploads, 1);
        assert.equal(streams, 1);
        info.mimeType = 'image/png';
        await assert.rejects(
            renderer.render({
                ...message,
                messageId: 'm:0200000000000000',
                content: {type: 'image', mimeType: 'image/png', byteSize: bytes.length},
            }),
            /MIME_MISMATCH/,
        );
        assert.equal(uploads, 1);
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
