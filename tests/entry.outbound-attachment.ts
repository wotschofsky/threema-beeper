import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCipheriv, createHash, randomBytes} from 'node:crypto';
import {mkdtemp, rm, readdir, readFile, truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {prepareOutboundAttachment} from '../src/media/outbound-attachment.ts';

await test('outbound attachment verifies before parsing and streams plaintext from ciphertext-only storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'outbound-media-'));
    const key = randomBytes(32),
        iv = randomBytes(16),
        plain = randomBytes(200000);
    const cipher = createCipheriv('aes-256-ctr', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    let sniffed = 0;
    const input = {
        bytes: plain.length,
        maxBytes: 300000,
        mimeType: 'application/octet-stream',
        file: {
            v: 'v2',
            key: {kty: 'oct', alg: 'A256CTR', k: key.toString('base64url'), key_ops: ['decrypt']},
            iv: iv.toString('base64'),
            hashes: {sha256: createHash('sha256').update(ciphertext).digest('base64')},
        },
        verifyMime: async (header: Buffer) => {
            sniffed++;
            assert.deepEqual(header, plain.subarray(0, 4096));
        },
    };
    try {
        const prepared = await prepareOutboundAttachment(
            Readable.from([ciphertext]),
            directory,
            input,
        );
        assert.equal(sniffed, 1);
        const spool = (await readdir(directory))[0]!;
        assert.deepEqual(await readFile(join(directory, spool, 'ciphertext')), ciphertext);
        const chunks: Buffer[] = [];
        for await (const chunk of prepared.stream()) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), plain);
        // Arbitrary offsets include unaligned cipher blocks and reads across 64 KiB chunks.
        for (const [start, end] of [
            [0, 1],
            [15, 17],
            [16, 32],
            [65531, 131079],
            [plain.length - 19, plain.length],
        ])
            assert.deepEqual(await prepared.read(start!, end!), plain.subarray(start, end));
        const parallel = await Promise.all([
            prepared.read(7, 100),
            prepared.read(1000, 1024),
            prepared.read(30000, 30037),
            prepared.read(1, 2),
        ]);
        assert.deepEqual(parallel, [
            plain.subarray(7, 100),
            plain.subarray(1000, 1024),
            plain.subarray(30000, 30037),
            plain.subarray(1, 2),
        ]);
        for (const [start, end] of [
            [-1, 1],
            [0, 0],
            [2, 1],
            [0, plain.length + 1],
            [0.5, 1],
            [0, NaN],
        ])
            await assert.rejects(prepared.read(start!, end!));
        const active = Array.from({length: 4}, () => prepared.read(0, 100));
        await assert.rejects(prepared.read(0, 1), /concurrency/);
        await Promise.all(active);
        await prepared.dispose();
        await assert.rejects(prepared.read(0, 1), /disposed/);
        assert.throws(() => prepared.stream(), /disposed/);
        assert.deepEqual(await readdir(directory), []);
        const corrupt = Buffer.from(ciphertext);
        corrupt[0] ^= 1;
        await assert.rejects(
            prepareOutboundAttachment(Readable.from([corrupt]), directory, input),
            /hash mismatch/,
        );
        assert.equal(sniffed, 1, 'Corruption is rejected before plaintext reaches MIME parsing');
        await assert.rejects(
            prepareOutboundAttachment(Readable.from([ciphertext]), directory, {
                ...input,
                maxBytes: 1,
            }),
            /Invalid/,
        );
        await assert.rejects(
            prepareOutboundAttachment(Readable.from([ciphertext]), directory, {
                ...input,
                bytes: undefined,
                maxBytes: 100,
            }),
            /size limit/,
        );
        await assert.rejects(
            prepareOutboundAttachment(Readable.from([ciphertext]), directory, {
                ...input,
                verifyMime: async () => {
                    throw new Error('MIME mismatch');
                },
            }),
            /MIME mismatch/,
        );
        const abort = new AbortController();
        abort.abort();
        await assert.rejects(
            prepareOutboundAttachment(Readable.from([ciphertext]), directory, {
                ...input,
                signal: abort.signal,
            }),
        );
        assert.deepEqual(await readdir(directory), []);
    } finally {
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});

await test('attachment range reads enforce limits, counter carry and cancellation without retained files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attachment-ranges-'));
    const key = randomBytes(32),
        iv = Buffer.from('1234567890abcdefffffffffffffffff', 'hex');
    const plain = randomBytes(2 * 1024 * 1024 + 97);
    const cipher = createCipheriv('aes-256-ctr', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const controller = new AbortController();
    const options = {
        bytes: plain.length,
        maxBytes: plain.length,
        mimeType: 'application/octet-stream',
        file: {
            v: 'v2',
            key: {kty: 'oct', alg: 'A256CTR', k: key.toString('base64url'), key_ops: ['decrypt']},
            iv: iv.toString('base64'),
            hashes: {sha256: createHash('sha256').update(ciphertext).digest('base64')},
        },
        verifyMime: async () => {},
    };
    const source = () =>
        Readable.from([
            ciphertext.subarray(0, 1024 * 1024),
            ciphertext.subarray(1024 * 1024, 2 * 1024 * 1024),
            ciphertext.subarray(2 * 1024 * 1024),
        ]);
    try {
        const prepared = await prepareOutboundAttachment(source(), directory, {
            ...options,
            signal: controller.signal,
        });
        assert.deepEqual(
            await prepared.read(17, 1024 * 1024 + 17),
            plain.subarray(17, 1024 * 1024 + 17),
        );
        await assert.rejects(prepared.read(0, 1024 * 1024 + 1), /range/);
        const pending = prepared.read(0, 1024);
        controller.abort();
        await assert.rejects(pending);
        await assert.rejects(prepared.read(0, 1));
        await prepared.dispose();
        const disposed = await prepareOutboundAttachment(source(), directory, options);
        const reading = disposed.read(0, 1024);
        const cleanup = disposed.dispose();
        await assert.rejects(reading, /disposed/);
        await cleanup;
        const truncated = await prepareOutboundAttachment(source(), directory, options);
        const spool = (await readdir(directory))[0]!;
        await truncate(join(directory, spool, 'ciphertext'), 32);
        await assert.rejects(truncated.read(17, 100), /truncated/);
        await truncated.dispose();
        assert.deepEqual(await readdir(directory), []);
    } finally {
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
