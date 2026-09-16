import {MessageChannel} from 'node:worker_threads';
import {serveByteStream, receiveByteStream} from '../src/threema/byte-stream.ts';
import assert from 'node:assert/strict';
import {createHash, randomFillSync} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Readable} from 'node:stream';
import {test} from 'node:test';

interface Handle {
    fileId: string;
    unencryptedByteCount: number;
    storageFormatVersion: number;
    encryptionKey: unknown;
}
interface Storage {
    store(data: Uint8Array): Promise<Handle>;
    storeStream(
        source: AsyncIterable<Uint8Array>,
        bytes: number,
        signal?: AbortSignal,
    ): Promise<Handle>;
    load(handle: Handle): Promise<Uint8Array>;
    getRawPath(id: string): Promise<string>;
}
const {
    ProbeFileStorage,
    openNodeStoredFile,
    describeNodeStoredFile,
    resolveNodeMedia,
    ProbeFileController,
} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
) as {
    ProbeFileController: {
        prototype: {ensureCached(this: unknown, part: string): Promise<void>};
    };
    resolveNodeMedia(
        handle: unknown,
        storage: Storage,
        request: {
            chatId: string;
            messageId: string;
            part: 'file' | 'thumbnail';
            maximumBytes: number;
        },
    ): Promise<{bytes: number; sha256: string; mimeType: string; open(): Readable}>;
    ProbeFileStorage: new (services: unknown, logger: unknown, directory: string) => Storage;
    openNodeStoredFile(
        storage: Storage,
        handle: Handle,
        maximum: number,
        signal?: AbortSignal,
    ): Readable;
    describeNodeStoredFile(
        storage: Storage,
        handle: Handle,
        maximum: number,
    ): Promise<{bytes: number; sha256: string}>;
};
await test('bounded stream reads authentic upstream files and rejects tampering, truncation, limits and abort', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-file-stream-'));
    const storage = new ProbeFileStorage(
        {crypto: {randomBytes: (bytes: Uint8Array) => randomFillSync(bytes)}},
        new Proxy({}, {get: () => () => {}}),
        directory,
    );
    try {
        for (const size of [0, 1, 1024 * 1024, 2 * 1024 * 1024 + 7]) {
            const data = Buffer.alloc(size, 0x61);
            const handle = await storage.store(data);
            assert.deepEqual(await describeNodeStoredFile(storage, handle, size), {
                bytes: size,
                sha256: createHash('sha256').update(data).digest('hex'),
            });
            const hash = createHash('sha256');
            let received = 0;
            const {port1, port2} = new MessageChannel();
            const serving = serveByteStream(port1, openNodeStoredFile(storage, handle, size), {
                bytes: size,
            });
            for await (const chunk of receiveByteStream(port2, {bytes: size})) {
                assert.ok(chunk.length <= 1024 * 1024);
                hash.update(chunk);
                received += chunk.length;
            }
            await serving;
            assert.equal(received, size);
            assert.equal(hash.digest('hex'), createHash('sha256').update(data).digest('hex'));
            assert.throws(
                () => openNodeStoredFile(storage, {...handle, storageFormatVersion: 99}, size),
                /Unsupported/,
            );
            if (size) assert.throws(() => openNodeStoredFile(storage, handle, size - 1), /limit/);
            const path = await storage.getRawPath(handle.fileId);
            const encrypted = await readFile(path);
            await writeFile(path, Buffer.concat([encrypted, Buffer.from([0])]));
            await assert.rejects(describeNodeStoredFile(storage, handle, size), /length mismatch/);
            if (size) {
                encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;
                await writeFile(path, encrypted);
                await assert.rejects(describeNodeStoredFile(storage, handle, size));
            }
        }
        const mediaBytes = Buffer.from('retained media');
        const mediaHandle = await storage.store(mediaBytes);
        const wrap = <T>(value: T) => ({get: () => value});
        const media: {
            type: string;
            view: Record<string, unknown>;
            controller: {ensureCached(part: string): Promise<void>};
        } = {
            type: 'file',
            controller: {ensureCached: async () => {}},
            view: {
                fileData: mediaHandle,
                fileSize: mediaBytes.length,
                mediaType: 'application/octet-stream',
            },
        };
        let requested: bigint | undefined;
        const backend = {
            model: {
                user: {identity: 'SELF1234'},
                conversations: {
                    getAll: async () =>
                        wrap(
                            new Set([
                                wrap({
                                    controller: {
                                        receiver: async () =>
                                            wrap({type: 0, view: {identity: 'TEST1234'}}),
                                        getMessage: async (id: bigint) => {
                                            requested = id;
                                            return wrap(media);
                                        },
                                    },
                                }),
                            ]),
                        ),
                },
            },
        };
        const request = {
            chatId: 'c:TEST1234',
            messageId: 'm:ffffffffffffffff',
            part: 'file' as const,
            maximumBytes: 100,
        };
        const resolved = await resolveNodeMedia(backend, storage, request);
        assert.equal(requested, 0xffffffffffffffffn);
        assert.equal(resolved.bytes, mediaBytes.length);
        assert.equal(resolved.mimeType, 'application/octet-stream');
        assert.deepEqual(Object.keys(resolved).sort(), ['bytes', 'mimeType', 'open', 'sha256']);
        const chunks: Buffer[] = [];
        for await (const chunk of resolved.open()) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), mediaBytes);
        await assert.rejects(
            resolveNodeMedia(backend, storage, {...request, part: 'thumbnail'}),
            /NOT_CACHED/,
        );
        let downloads = 0;
        delete media.view.fileData;
        media.controller.ensureCached = async (part) => {
            const result = await ProbeFileController.prototype.ensureCached.call(
                {
                    blob: async () => {
                        downloads++;
                        media.view.fileData = mediaHandle;
                        return {bytes: mediaBytes, mediaType: 'application/octet-stream'};
                    },
                },
                part,
            );
            assert.equal(result, undefined, 'Cache command must not return blob bytes');
        };
        const downloaded = await resolveNodeMedia(backend, storage, request);
        assert.equal(downloaded.sha256, resolved.sha256);
        assert.equal(downloads, 1);
        await resolveNodeMedia(backend, storage, request);
        assert.equal(downloads, 1);
        delete media.view.fileData;
        await assert.rejects(
            resolveNodeMedia(backend, storage, {...request, maximumBytes: mediaBytes.length - 1}),
            /TOO_LARGE/,
        );
        assert.equal(downloads, 1);
        media.view.fileData = mediaHandle;
        media.view.fileSize = mediaBytes.length + 1;
        await assert.rejects(resolveNodeMedia(backend, storage, request), /SIZE_MISMATCH/);
        media.type = 'deleted';
        await assert.rejects(resolveNodeMedia(backend, storage, request), /UNSUPPORTED/);
        await assert.rejects(
            resolveNodeMedia(backend, storage, {...request, chatId: 'c:OTHER123'}),
            /CONVERSATION_NOT_FOUND/,
        );
        const handle = await storage.store(Buffer.alloc(2 * 1024 * 1024));
        const abort = new AbortController();
        await assert.rejects(async () => {
            for await (const _chunk of openNodeStoredFile(
                storage,
                handle,
                handle.unencryptedByteCount,
                abort.signal,
            ))
                abort.abort();
        });
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});

await test('streaming upstream writes remain load-compatible and remove partial ciphertext on failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-stream-write-'));
    const storage = new ProbeFileStorage(
        {crypto: {randomBytes: (bytes: Uint8Array) => randomFillSync(bytes)}},
        new Proxy({}, {get: () => () => {}}),
        directory,
    );
    const chunks = async function* (data: Uint8Array) {
        for (let offset = 0; offset < data.length; offset += 77777)
            yield data.subarray(offset, offset + 77777);
    };
    const files = async () => {
        let count = 0;
        for (const prefix of await readdir(directory))
            count += (await readdir(join(directory, prefix))).length;
        return count;
    };
    try {
        for (const size of [0, 1, 1024 * 1024, 2 * 1024 * 1024 + 7]) {
            const data = Buffer.alloc(size, 0x5a);
            const handle = await storage.storeStream(chunks(data), size);
            assert.deepEqual(Buffer.from(await storage.load(handle)), data);
            assert.equal(
                (await describeNodeStoredFile(storage, handle, size)).sha256,
                createHash('sha256').update(data).digest('hex'),
            );
        }
        const before = await files();
        await assert.rejects(storage.storeStream(chunks(Buffer.alloc(10)), 11), /truncated/);
        await assert.rejects(storage.storeStream(chunks(Buffer.alloc(11)), 10), /bounds/);
        const abort = new AbortController();
        const cancelled = async function* () {
            yield Buffer.alloc(1024 * 1024);
            abort.abort();
            yield Buffer.alloc(1);
        };
        await assert.rejects(storage.storeStream(cancelled(), 1024 * 1024 + 1, abort.signal));
        const failed = async function* () {
            yield Buffer.alloc(1024 * 1024);
            throw new Error('source failed');
        };
        await assert.rejects(storage.storeStream(failed(), 1024 * 1024 + 1), /source failed/);
        assert.equal(await files(), before, 'Failed writes must not leave ciphertext behind');
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
