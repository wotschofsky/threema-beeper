import {BackendController} from '../src/threema/backend-controller.ts';
import {SendAllocation} from '../src/threema/send-allocation.ts';
import {parsePreparedFileSend} from '../src/threema/prepared-file-send.ts';
import {parsePreparedImageSend} from '../src/threema/prepared-image-send.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {randomFillSync} from 'node:crypto';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {NodePreparedFiles, ProbeFileStorage} = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
await test('opaque prepared files enforce chat, capacity and single claim while retaining uncertain file data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'prepared-files-'));
    const storage = new ProbeFileStorage(
        {crypto: {randomBytes: (bytes: Uint8Array) => randomFillSync(bytes)}},
        new Proxy({}, {get: () => () => {}}),
        directory,
    );
    const registry = new NodePreparedFiles(storage, 10);
    const source = async function* () {
        yield Buffer.from('abc');
    };
    try {
        const first = await registry.prepare('c:ABCD1234', source(), 3);
        const discarded = await registry.prepare('c:ABCD1234', source(), 3);
        assert.match(first, /^[a-f0-9]{64}$/);
        assert.notEqual(first, discarded);
        await assert.rejects(registry.prepare('c:ABCD1234', source(), 5), /capacity/);
        assert.throws(() => registry.claim(first, 'c:OTHER123'));
        const handle = registry.claim(first, 'c:ABCD1234');
        assert.deepEqual(Buffer.from(await storage.load(handle)), Buffer.from('abc'));
        assert.throws(() => registry.claim(first, 'c:ABCD1234'));
        assert.throws(() => registry.transferred(discarded));
        await registry.close();
        assert.deepEqual(Buffer.from(await storage.load(handle)), Buffer.from('abc'));
        let files = 0;
        for (const prefix of await readdir(directory))
            files += (await readdir(join(directory, prefix))).length;
        assert.equal(files, 1, 'Only the uncertain claimed file remains');
        assert.throws(() => registry.claim(discarded, 'c:ABCD1234'));
        await assert.rejects(registry.prepare('c:ABCD1234', source(), 3));
        await registry.close();
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
await test('shutdown waits for in-flight preparation and cleans the newly stored unclaimed handle', async () => {
    let complete!: (handle: unknown) => void;
    const deleted: string[] = [];
    const registry = new NodePreparedFiles(
        {
            storeStream: () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
            delete: async (id: string) => {
                deleted.push(id);
                return true;
            },
        },
        10,
    );
    const source = async function* () {
        yield Buffer.from('abc');
    };
    const preparing = registry.prepare('c:ABCD1234', source(), 3);
    const rejected = assert.rejects(preparing, /closed/);
    const closing = registry.close();
    complete({fileId: 'local-only', unencryptedByteCount: 3});
    await rejected;
    await closing;
    assert.deepEqual(deleted, ['local-only']);
});

await test('file staging checks profile and group membership before consuming source data', async () => {
    const {prepareNodeFile, ProbeReceiverType, ProbeGroupUserState} = createRequire(
        import.meta.url,
    )('../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs');
    let staged = 0;
    const registry = {
        prepare: async () => {
            staged++;
            return 'opaque';
        },
    };
    const receiver = {type: ProbeReceiverType.CONTACT, view: {identity: 'ABCD1234'}} as any;
    const handle = {
        model: {
            user: {identity: 'SELF1234'},
            conversations: {
                getAll: async () => ({
                    get: () =>
                        new Set([
                            {
                                get: () => ({
                                    controller: {receiver: async () => ({get: () => receiver})},
                                }),
                            },
                        ]),
                }),
            },
        },
    };
    const request = {profile: 'SELF1234', chatId: 'c:ABCD1234', bytes: 3};
    const source = async function* () {
        yield Buffer.from('abc');
    };
    await assert.rejects(
        prepareNodeFile(handle, registry, {...request, profile: 'OTHER123'}, source()),
    );
    await assert.rejects(
        prepareNodeFile(handle, registry, {...request, chatId: 'c:MISSING1'}, source()),
    );
    assert.equal(staged, 0);
    assert.equal(await prepareNodeFile(handle, registry, request, source()), 'opaque');
    receiver.type = ProbeReceiverType.GROUP;
    receiver.view = {creator: 'me', groupId: 1n, userState: ProbeGroupUserState.LEFT};
    await assert.rejects(
        prepareNodeFile(
            handle,
            registry,
            {...request, chatId: 'g:SELF1234:0100000000000000'},
            source(),
        ),
    );
    assert.equal(staged, 1);
});

const imageRuntime = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
const imageEndpoint = imageRuntime.ProbeEndpointService({
    logging: {logger: () => imageRuntime.ProbeNoopLogger},
});
for (const imageType of ['image/jpeg', 'image/gif', 'image/webp', 'image/png'] as const)
    await test(`real Desktop proxy sends a prepared token while storage keys remain behind the controller (${imageType})`, async () => {
        const runtime = createRequire(import.meta.url)(
            '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
        );
        const directory = await mkdtemp(join(tmpdir(), 'prepared-proxy-'));
        const crypto = {randomBytes: (bytes: Uint8Array) => randomFillSync(bytes)};
        const storage = new runtime.ProbeFileStorage({crypto}, runtime.ProbeNoopLogger, directory);
        const registry = new runtime.NodePreparedFiles(storage, 100);
        storage.preparedFiles = registry;
        const endpoint = imageEndpoint;
        const pair = endpoint.createEndpointPair();
        const sent: any[] = [];
        let identity = 'OTHER123',
            recorded = false;
        const context = Object.assign(Object.create(runtime.ProbeSendController.prototype), {
            _services: {crypto, file: storage, device: {identity: {string: 'SELF1234'}}},
            _log: runtime.ProbeNoopLogger,
            _conversation: {
                get: () => ({
                    controller: {
                        receiver: () => ({
                            get: () => ({
                                type: runtime.ProbeReceiverType.CONTACT,
                                view: {identity},
                            }),
                        }),
                        addMessage: {
                            fromLocal: async (message: unknown) => {
                                assert.equal(recorded, true);
                                sent.push(message);
                            },
                        },
                    },
                }),
            },
        });
        endpoint.exposeProxy(
            {
                [runtime.ProbeTransferHandler]: runtime.ProbeProxyHandler,
                sendPreparedImageWithIds: async (
                    token: string,
                    thumbnail: string,
                    metadata: unknown,
                    hook: any,
                ) => {
                    try {
                        return await context.sendPreparedImageWithIds(
                            token,
                            thumbnail,
                            metadata,
                            hook,
                        );
                    } finally {
                        hook[runtime.ProbeReleaseProxy]();
                    }
                },
                sendPreparedFileWithIds: async (token: string, metadata: unknown, hook: any) => {
                    try {
                        return await context.sendPreparedFileWithIds(token, metadata, hook);
                    } finally {
                        hook[runtime.ProbeReleaseProxy]();
                    }
                },
            },
            pair.local,
        );
        const proxy = endpoint.wrap(pair.remote, runtime.ProbeNoopLogger);
        const recorder = (expected = 0) => ({
            [runtime.ProbeTransferHandler]: runtime.ProbeProxyHandler,
            record: async (ids: readonly bigint[]) => {
                assert.equal(ids.length, 1);
                assert.equal(sent.length, expected);
                recorded = true;
            },
        });
        const source = async function* () {
            yield Buffer.from('abc');
        };
        try {
            const token = await registry.prepare('c:ABCD1234', source(), 3);
            const metadata = {fileName: 'fixture.bin', mediaType: 'application/octet-stream'};
            await assert.rejects(proxy.sendPreparedFileWithIds(token, metadata, recorder()));
            assert.equal(sent.length, 0);
            identity = 'ABCD1234';
            for (const invalid of [
                {...metadata, fileName: '../invalid'},
                {...metadata, fileName: ''},
                {...metadata, mediaType: 'invalid'},
                {...metadata, caption: 42},
                {...metadata, audioDurationSeconds: 0.25},
                ...[0, -1, NaN, Infinity, 10001, '0.25'].map((audioDurationSeconds) => ({
                    ...metadata,
                    mediaType: 'audio/mp4',
                    audioDurationSeconds,
                })),
                null,
            ]) {
                await assert.rejects(proxy.sendPreparedFileWithIds(token, invalid, recorder()));
                assert.equal(sent.length, 0);
                assert.equal(
                    recorded,
                    false,
                    'Invalid metadata cannot reach the allocation barrier',
                );
            }
            // The valid send below must still be able to claim this same token.
            const localController = {
                async sendPreparedFileWithIds(...args: any[]) {
                    assert.equal(
                        this,
                        localController,
                        'Native media methods retain their controller',
                    );
                    return await Reflect.apply(proxy.sendPreparedFileWithIds, proxy, args);
                },
                async sendPreparedImageWithIds(...args: any[]) {
                    assert.equal(
                        this,
                        localController,
                        'Native media methods retain their controller',
                    );
                    return await Reflect.apply(proxy.sendPreparedImageWithIds, proxy, args);
                },
            };
            const backend = {
                model: {
                    user: {identity: 'SELF1234'},
                    conversations: {
                        getAll: async () => ({get: () => new Set([context._conversation])}),
                    },
                },
                viewModel: {conversation: async () => ({viewModelController: localController})},
            };
            const outer = {
                request: async (command: string, password: unknown, data: any) => {
                    assert(['send-prepared-file', 'send-prepared-image'].includes(command));
                    assert.equal(password, undefined);
                    const allocation = new SendAllocation(data.port);
                    try {
                        if (command === 'send-prepared-image')
                            return await runtime.sendNodePreparedImage(
                                backend,
                                parsePreparedImageSend(data.request),
                                (ids: readonly string[]) => allocation.record(ids),
                            );
                        return await runtime.sendNodePreparedFile(
                            backend,
                            parsePreparedFileSend(data.request),
                            (ids: readonly string[]) => allocation.record(ids),
                        );
                    } finally {
                        allocation.close();
                    }
                },
            };
            const request = {profile: 'SELF1234', chatId: 'c:ABCD1234', token, ...metadata};
            for (const duration of [0, -1, NaN, Infinity, 10001, '0.25'])
                assert.throws(() =>
                    parsePreparedFileSend({
                        ...request,
                        mediaType: 'audio/mp4',
                        audioDurationSeconds: duration,
                    }),
                );
            assert.throws(() => parsePreparedFileSend({...request, audioDurationSeconds: 0.25}));
            let recordedIds: readonly string[] = [];
            const ids = await BackendController.prototype.sendPreparedFile.call(
                outer as any,
                request,
                async (allocated) => {
                    assert.equal(sent.length, 0);
                    recordedIds = [...allocated];
                    recorded = true;
                },
            );
            assert.deepEqual(ids, recordedIds);
            assert.equal(ids.length, 1);
            assert.match(ids[0]!, /^m:[0-9a-f]{16}$/);
            assert.deepEqual(Buffer.from(await storage.load(sent[0].fileData)), Buffer.from('abc'));
            await assert.rejects(proxy.sendPreparedFileWithIds(token, metadata, recorder()));
            assert.equal(sent.length, 1);
            const image = await registry.prepare('c:ABCD1234', source(), 3);
            const thumbnail = await registry.prepare('c:ABCD1234', source(), 3);
            const imageMetadata = {
                fileName: 'image.jpg',
                mediaType: imageType,
                thumbnailMediaType: 'image/jpeg',
                dimensions: {width: 16, height: 8},
                thumbnailDimensions: {width: 8, height: 4},
            };
            await assert.rejects(
                proxy.sendPreparedImageWithIds(image, image, imageMetadata, recorder(1)),
            );
            await assert.rejects(
                proxy.sendPreparedImageWithIds(
                    image,
                    thumbnail,
                    {...imageMetadata, dimensions: {width: 0, height: 8}},
                    recorder(1),
                ),
            );
            recorded = false;
            const imageIds = await BackendController.prototype.sendPreparedImage.call(
                outer,
                {
                    profile: 'SELF1234',
                    chatId: 'c:ABCD1234',
                    token: image,
                    thumbnailToken: thumbnail,
                    fileName: 'image.jpg',
                    mediaType: imageType,
                    thumbnailMediaType: 'image/jpeg',
                    width: imageType === 'image/png' ? 1 : 16,
                    height: imageType === 'image/png' ? 1 : 8,
                    thumbnailWidth: 8,
                    thumbnailHeight: 4,
                },
                async (ids: readonly string[]) => {
                    assert.equal(sent.length, 1);
                    assert.match(ids[0]!, /^m:[0-9a-f]{16}$/);
                    recorded = true;
                },
            );
            assert.equal(imageIds.length, 1);
            assert.equal(sent.length, 2);
            assert.equal(sent[1].type, 'image');
            assert.equal(sent[1].mediaType, imageType);
            assert.equal(sent[1].thumbnailMediaType, 'image/jpeg');
            assert.deepEqual(
                sent[1].dimensions,
                imageType === 'image/png' ? {width: 1, height: 1} : {width: 16, height: 8},
            );
            assert.deepEqual(
                Buffer.from(await storage.load(sent[1].thumbnailFileData)),
                Buffer.from('abc'),
            );
            await assert.rejects(
                proxy.sendPreparedImageWithIds(image, thumbnail, imageMetadata, recorder(2)),
            );
            const audio = await registry.prepare('c:ABCD1234', source(), 3);
            recorded = false;
            const audioIds = await BackendController.prototype.sendPreparedFile.call(
                outer as any,
                {
                    profile: 'SELF1234',
                    chatId: 'c:ABCD1234',
                    token: audio,
                    fileName: 'voice.m4a',
                    mediaType: 'audio/mp4',
                    audioDurationSeconds: 0.25,
                },
                async (ids) => {
                    assert.equal(sent.length, 2);
                    assert.match(ids[0]!, /^m:[0-9a-f]{16}$/);
                    recorded = true;
                },
            );
            assert.equal(audioIds.length, 1);
            assert.equal(sent.length, 3);
            assert.equal(sent[2].type, 'audio');
            assert.equal(sent[2].duration, 0.25);
            assert.equal(sent[2].mediaType, 'audio/mp4');
            assert.deepEqual(Buffer.from(await storage.load(sent[2].fileData)), Buffer.from('abc'));
            await assert.rejects(
                proxy.sendPreparedFileWithIds(
                    audio,
                    {fileName: 'voice.m4a', mediaType: 'audio/mp4', audioDurationSeconds: 0.25},
                    recorder(3),
                ),
            );
            await registry.close();
            assert.deepEqual(Buffer.from(await storage.load(sent[0].fileData)), Buffer.from('abc'));
        } finally {
            pair.local.close();
            pair.remote.close();
            await registry.close();
            await rm(directory, {recursive: true, force: true});
        }
    });

await test('discard frees capacity, rejects claimed files, and coordinates with shutdown', async () => {
    let remove!: (value: boolean) => void;
    let next = 0;
    const registry = new NodePreparedFiles(
        {
            storeStream: async (_source: unknown, bytes: number) => ({
                fileId: String(next++),
                unencryptedByteCount: bytes,
            }),
            delete: () =>
                new Promise<boolean>((resolve) => {
                    remove = resolve;
                }),
        },
        3,
    );
    const source = async function* () {
        yield Buffer.from('abc');
    };
    const token = await registry.prepare('c:ABCD1234', source(), 3);
    await assert.rejects(registry.discard(token, 'c:OTHER123'));
    const deleting = registry.discard(token, 'c:ABCD1234');
    assert.throws(() => registry.claim(token, 'c:ABCD1234'));
    assert.throws(() => registry.transferred(token));
    await assert.rejects(registry.prepare('c:ABCD1234', source(), 3));
    remove(true);
    assert.equal(await deleting, true);
    assert.equal(await registry.discard(token, 'c:ABCD1234'), false);
    const claimed = await registry.prepare('c:ABCD1234', source(), 3);
    registry.claim(claimed, 'c:ABCD1234');
    await assert.rejects(registry.discard(claimed, 'c:ABCD1234'));
    registry.transferred(claimed);
    const last = await registry.prepare('c:ABCD1234', source(), 3);
    const pending = registry.discard(last, 'c:ABCD1234');
    let closed = false;
    const closing = registry.close().then(() => {
        closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    remove(true);
    await pending;
    await closing;
    assert.equal(closed, true);
});

await test('failed cleanup retains the handle and permits a later cleanup retry', async () => {
    let fail = true,
        deletes = 0;
    const registry = new NodePreparedFiles(
        {
            storeStream: async () => ({fileId: 'local', unencryptedByteCount: 1}),
            delete: async () => {
                deletes++;
                if (fail) throw new Error('disk unavailable');
                return true;
            },
        },
        1,
    );
    await registry.prepare(
        'c:ABCD1234',
        (async function* () {
            yield Buffer.from('x');
        })(),
        1,
    );
    await assert.rejects(registry.close(), /cleanup incomplete/);
    fail = false;
    await registry.close();
    assert.equal(deletes, 2);
    await registry.close();
    assert.equal(deletes, 2);
});

await test('image and thumbnail token bundles are claimed and transferred atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'prepared-bundle-'));
    const storage = new ProbeFileStorage(
        {crypto: {randomBytes: (bytes: Uint8Array) => randomFillSync(bytes)}},
        new Proxy({}, {get: () => () => {}}),
        directory,
    );
    const registry = new NodePreparedFiles(storage, 9);
    const source = async function* () {
        yield Buffer.from('abc');
    };
    try {
        const main = await registry.prepare('c:ABCD1234', source(), 3);
        const thumbnail = await registry.prepare('c:ABCD1234', source(), 3);
        const foreign = await registry.prepare('c:OTHER123', source(), 3);
        assert.throws(() => registry.claimMany([main, main], 'c:ABCD1234'));
        assert.throws(() => registry.claimMany([main, 'a'.repeat(64)], 'c:ABCD1234'));
        assert.throws(() => registry.claimMany([main, foreign], 'c:ABCD1234'));
        const handles = registry.claimMany([main, thumbnail], 'c:ABCD1234');
        assert.equal(handles.length, 2);
        assert.throws(() => registry.claimMany([main, thumbnail], 'c:ABCD1234'));
        assert.throws(() => registry.transferredMany([main, foreign]));
        assert.throws(() => registry.transferredMany([main, main]));
        await assert.rejects(registry.prepare('c:ABCD1234', source(), 3), /capacity/);
        registry.transferredMany([main, thumbnail]);
        const later = await registry.prepare('c:ABCD1234', source(), 3);
        assert.equal(await registry.discard(later, 'c:ABCD1234'), true);
        await registry.close();
        for (const handle of handles)
            assert.deepEqual(Buffer.from(await storage.load(handle)), Buffer.from('abc'));
    } finally {
        await registry.close();
        await rm(directory, {recursive: true, force: true});
    }
});
