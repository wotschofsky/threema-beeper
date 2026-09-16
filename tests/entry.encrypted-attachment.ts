import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {
    getRequestFn,
    setRequestFn,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';
import {uploadAttachment} from '../src/media/upload-attachment.ts';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {
    Attachment,
    EncryptedAttachment,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/index.js';
import {prepareAttachment} from '../src/media/encrypted-attachment.ts';

await test('streamed Matrix v2 attachment decrypts with pinned native crypto and rejects tampering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-attachment-'));
    const plain = Buffer.alloc(512 * 1024 + 7, 0x41);
    const options = {
        bytes: plain.length,
        sha256: createHash('sha256').update(plain).digest('hex'),
        mimeType: 'application/octet-stream',
        maxBytes: 1024 * 1024,
        verifyMime: async (header: Buffer) => {
            assert.equal(header.length, 4096);
        },
    };
    const source = () =>
        Readable.from(
            (function* () {
                for (let i = 0; i < plain.length; i += 8191) yield plain.subarray(i, i + 8191);
            })(),
        );
    try {
        const prepared = await prepareAttachment(source(), directory, options);
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of prepared.stream()) chunks.push(chunk);
            const ciphertext = Buffer.concat(chunks);
            const request = getRequestFn();
            try {
                setRequestFn(
                    async (url: URL, options: {body: unknown; headers: Record<string, string>}) => {
                        assert.equal(url.pathname, '/_matrix/media/v3/upload');
                        assert.equal(url.search, '');
                        assert.equal(options.headers['Content-Type'], 'application/octet-stream');
                        assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
                        assert.ok(options.body instanceof Readable);
                        const uploaded: Buffer[] = [];
                        for await (const chunk of options.body) uploaded.push(chunk);
                        assert.deepEqual(Buffer.concat(uploaded), ciphertext);
                        return {
                            statusCode: 200,
                            headers: {},
                            body: {
                                bytes: async () =>
                                    Buffer.from(
                                        JSON.stringify({
                                            content_uri: 'mxc://matrix.invalid/encrypted',
                                        }),
                                    ),
                            },
                        };
                    },
                );
                const file = await uploadAttachment(
                    new MatrixClient('https://matrix.invalid', 'synthetic-token'),
                    prepared,
                );
                assert.equal(file.url, 'mxc://matrix.invalid/encrypted');
                assert.deepEqual(file.hashes, prepared.file.hashes);
            } finally {
                setRequestFn(request);
            }
            assert.equal(ciphertext.length, plain.length);
            assert.notDeepEqual(ciphertext, plain);
            assert.deepEqual(
                Buffer.from(
                    Attachment.decrypt(
                        new EncryptedAttachment(ciphertext, JSON.stringify(prepared.file)),
                    ),
                ),
                plain,
            );
            assert.equal(
                Buffer.from(prepared.file.iv, 'base64').subarray(8).equals(Buffer.alloc(8)),
                true,
            );
            ciphertext[0] = ciphertext[0]! ^ 1;
            assert.throws(() =>
                Attachment.decrypt(
                    new EncryptedAttachment(ciphertext, JSON.stringify(prepared.file)),
                ),
            );
        } finally {
            await prepared.dispose();
        }
        assert.throws(() => prepared.stream(), /disposed/);
        assert.deepEqual(await readdir(directory), []);
        await assert.rejects(
            prepareAttachment(source(), directory, {...options, bytes: plain.length - 1}),
            /bounds/,
        );
        await assert.rejects(
            prepareAttachment(source(), directory, {...options, sha256: '0'.repeat(64)}),
            /SHA-256/,
        );
        await assert.rejects(
            prepareAttachment(source(), directory, {
                ...options,
                verifyMime: async () => {
                    throw new Error('MIME mismatch');
                },
            }),
            /MIME/,
        );
        await assert.rejects(
            prepareAttachment(source(), directory, {...options, maxBytes: 10}),
            /size limit/,
        );
        const abort = new AbortController();
        const cancelling = Readable.from(
            (async function* () {
                yield Buffer.alloc(10);
                abort.abort();
                yield Buffer.alloc(10);
            })(),
        );
        await assert.rejects(
            prepareAttachment(cancelling, directory, {...options, signal: abort.signal}),
        );
        assert.deepEqual(await readdir(directory), []);
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
