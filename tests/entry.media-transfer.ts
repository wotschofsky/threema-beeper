import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MediaTransfer} from '../src/media/media-transfer.ts';

await test('media retries reuse persisted ciphertext and completed uploads survive restart without opening the source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-transfer-'));
    const key = randomBytes(32),
        filename = join(directory, 'store.sqlite');
    let store = new PortalStore(filename, key);
    let transfer = new MediaTransfer(store, directory);
    const plain = Buffer.from('private attachment fixture');
    const input = {
        bytes: plain.length,
        sha256: createHash('sha256').update(plain).digest('hex'),
        mimeType: 'application/octet-stream',
        maxBytes: 1024,
        verifyMime: async () => {},
    };
    let reads = 0,
        uploads = 0,
        fail = true;
    const source = async () => {
        reads++;
        return Readable.from([plain]);
    };
    const client = new MatrixClient('https://matrix.invalid', 'synthetic');
    const payloads: Buffer[] = [];
    client.doRequest = async (_method, _path, _query, body): Promise<any> => {
        assert.ok(store.mediaUpload('media-1'));
        const chunks: Buffer[] = [];
        for await (const chunk of body as Readable) chunks.push(chunk);
        payloads.push(Buffer.concat(chunks));
        uploads++;
        if (fail) throw new Error('synthetic upload response lost');
        return {content_uri: 'mxc://matrix.invalid/uploaded'};
    };
    try {
        await assert.rejects(
            transfer.transfer('media-1', 'SELF1234', client, source, input),
            /response lost/,
        );
        assert.equal(reads, 1);
        assert.equal(uploads, 1);
        const descriptor = JSON.parse(store.mediaUpload('media-1')!.prepared);
        store.close();
        store = new PortalStore(filename, key);
        transfer = new MediaTransfer(store, directory);
        await assert.rejects(
            transfer.transfer('media-1', 'OTHER', client, source, input),
            /conflict/,
        );
        fail = false;
        const result = await transfer.transfer('media-1', 'SELF1234', client, source, input);
        assert.deepEqual(payloads[0], payloads[1]);
        assert.equal(reads, 1);
        assert.equal(result.key.k, descriptor.file.key.k);
        assert.ok(!(await readdir(directory)).some((name) => name.startsWith('attachment-')));
        store.close();
        store = new PortalStore(filename, key);
        transfer = new MediaTransfer(store, directory);
        const cached = await transfer.transfer('media-1', 'SELF1234', client, source, input);
        assert.deepEqual(cached, result);
        assert.equal(uploads, 2);
        assert.equal(reads, 1);
        // A failed new operation retains a spool; corruption must prevent another upload.
        fail = true;
        await assert.rejects(transfer.transfer('media-2', 'SELF1234', client, source, input));
        const pending = JSON.parse(store.mediaUpload('media-2')!.prepared);
        await writeFile(join(directory, pending.spoolId, 'ciphertext'), Buffer.alloc(plain.length));
        const before = uploads;
        await assert.rejects(
            transfer.transfer('media-2', 'SELF1234', client, source, input),
            /hash mismatch/,
        );
        assert.equal(uploads, before);
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});

await test('missing upload spools recover from verified source after restart without replacing completed metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-transfer-recovery-'));
    const key = randomBytes(32),
        filename = join(directory, 'store.sqlite');
    let store = new PortalStore(filename, key);
    const plain = Buffer.from('recoverable private attachment');
    const input = {
        bytes: plain.length,
        sha256: createHash('sha256').update(plain).digest('hex'),
        mimeType: 'application/octet-stream',
        maxBytes: 1024,
        verifyMime: async () => {},
    };
    const client = new MatrixClient('https://matrix.invalid', 'synthetic');
    let uploads = 0,
        fail = true;
    client.doRequest = async (_method, _path, _query, body): Promise<any> => {
        for await (const _chunk of body as Readable) {
            /* consume ciphertext */
        }
        uploads++;
        if (fail) throw new Error('synthetic response lost');
        return {content_uri: 'mxc://matrix.invalid/recovered'};
    };
    const source = async () => Readable.from([plain]);
    try {
        for (const missing of ['directory', 'file']) {
            fail = true;
            let transfer = new MediaTransfer(store, directory);
            await assert.rejects(transfer.transfer(missing, 'SELF1234', client, source, input));
            const previous = store.mediaUpload(missing)!;
            const descriptor = JSON.parse(previous.prepared);
            const spool = join(directory, descriptor.spoolId);
            await rm(missing === 'directory' ? spool : join(spool, 'ciphertext'), {
                recursive: true,
            });
            store.close();
            store = new PortalStore(filename, key);
            transfer = new MediaTransfer(store, directory);
            const before = uploads;
            // Source changes cannot silently replace the pending attachment.
            await assert.rejects(
                transfer.transfer(
                    missing,
                    'SELF1234',
                    client,
                    async () => Readable.from([Buffer.alloc(plain.length)]),
                    input,
                ),
                /SHA-256 mismatch/,
            );
            assert.equal(uploads, before);
            assert.equal(store.mediaUpload(missing)!.prepared, previous.prepared);
            fail = false;
            const result = await transfer.transfer(missing, 'SELF1234', client, source, input);
            assert.equal(uploads, before + 1);
            assert.notEqual(result.key.k, descriptor.file.key.k);
            assert.notEqual(result.iv, descriptor.file.iv);
            const completed = store.mediaUpload(missing)!;
            assert.deepEqual(JSON.parse(completed.result!), result);
            assert.throws(
                () =>
                    store.replaceMediaUpload(
                        missing,
                        previous.fingerprint,
                        previous.prepared,
                        previous.prepared,
                    ),
                /recovery conflict/,
            );
            assert.throws(
                () =>
                    store.replaceMediaUpload(
                        missing,
                        completed.fingerprint,
                        completed.prepared,
                        previous.prepared,
                    ),
                /recovery conflict/,
            );
            assert.deepEqual(
                await transfer.transfer(
                    missing,
                    'SELF1234',
                    client,
                    async () => {
                        throw new Error('completed source must not open');
                    },
                    input,
                ),
                result,
            );
            assert.ok(!(await readdir(directory)).some((name) => name.startsWith('attachment-')));
        }
    } finally {
        store.close();
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
