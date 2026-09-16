import {BackendController} from '../src/threema/backend-controller.ts';
import {SendAllocation} from '../src/threema/send-allocation.ts';
import {parsePreparedVideoSend} from '../src/threema/prepared-video-send.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {randomFillSync} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const runtime = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
const endpoint = runtime.ProbeEndpointService({logging: {logger: () => runtime.ProbeNoopLogger}});
for (const withThumbnail of [false, true])
    await test(`real video controller preserves token ownership and ID barrier (thumbnail=${withThumbnail})`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'video-controller-'));
        const crypto = {randomBytes: (bytes: Uint8Array) => randomFillSync(bytes)};
        const storage = new runtime.ProbeFileStorage({crypto}, runtime.ProbeNoopLogger, directory);
        const registry = new runtime.NodePreparedFiles(storage, 100);
        storage.preparedFiles = registry;
        const sent: any[] = [];
        let identity = 'OTHER123',
            recorded = false;
        const controller = Object.assign(Object.create(runtime.ProbeSendController.prototype), {
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
                                assert(recorded);
                                sent.push(message);
                            },
                        },
                    },
                }),
            },
        });
        const pair = endpoint.createEndpointPair();
        endpoint.exposeProxy(
            {
                [runtime.ProbeTransferHandler]: runtime.ProbeProxyHandler,
                sendPreparedVideoWithIds: async (
                    token: string,
                    thumbnail: string | undefined,
                    metadata: unknown,
                    hook: any,
                ) => {
                    try {
                        return await controller.sendPreparedVideoWithIds(
                            token,
                            thumbnail,
                            metadata,
                            hook,
                        );
                    } finally {
                        hook[runtime.ProbeReleaseProxy]();
                    }
                },
            },
            pair.local,
        );
        const proxy = endpoint.wrap(pair.remote, runtime.ProbeNoopLogger);
        const source = async function* () {
            yield Buffer.from('abc');
        };
        const recorder = (fail = false) => ({
            [runtime.ProbeTransferHandler]: runtime.ProbeProxyHandler,
            record: async (ids: bigint[]) => {
                assert.equal(ids.length, 1);
                if (fail) throw new Error('Synthetic persistence failure');
                assert.equal(sent.length, 0);
                recorded = true;
            },
        });
        try {
            const token = await registry.prepare('c:ABCD1234', source(), 3);
            const thumbnail = withThumbnail
                ? await registry.prepare('c:ABCD1234', source(), 3)
                : undefined;
            const metadata = {
                fileName: 'video.mp4',
                mediaType: 'video/mp4',
                durationSeconds: 1.25,
                dimensions: {width: 640, height: 360},
                ...(withThumbnail
                    ? {
                          thumbnailMediaType: 'image/jpeg',
                          thumbnailDimensions: {width: 256, height: 144},
                      }
                    : {}),
            };
            await assert.rejects(
                proxy.sendPreparedVideoWithIds(token, thumbnail, metadata, recorder()),
            );
            identity = 'ABCD1234';
            for (const invalid of [
                {...metadata, durationSeconds: 0},
                {...metadata, dimensions: {width: 8193, height: 1}},
                {...metadata, fileName: '../video.mp4'},
                {...metadata, mediaType: 'video/webm'},
                {...metadata, audioDurationSeconds: 1},
                {...metadata, fileData: {}},
            ])
                await assert.rejects(
                    proxy.sendPreparedVideoWithIds(token, thumbnail, invalid, recorder()),
                );
            if (withThumbnail)
                await assert.rejects(
                    proxy.sendPreparedVideoWithIds(token, 'c'.repeat(64), metadata, recorder()),
                );
            assert.equal(sent.length, 0);
            const localController = {
                async sendPreparedVideoWithIds(...args: any[]) {
                    assert.equal(
                        this,
                        localController,
                        'Native media methods retain their controller',
                    );
                    return await Reflect.apply(proxy.sendPreparedVideoWithIds, proxy, args);
                },
            };
            const backend = {
                model: {
                    user: {identity: 'SELF1234'},
                    conversations: {
                        getAll: async () => ({get: () => new Set([controller._conversation])}),
                    },
                },
                viewModel: {conversation: async () => ({viewModelController: localController})},
            };
            const outer = {
                request: async (command: string, password: unknown, data: any) => {
                    assert.equal(command, 'send-prepared-video');
                    assert.equal(password, undefined);
                    const allocation = new SendAllocation(data.port);
                    try {
                        return await runtime.sendNodePreparedVideo(
                            backend,
                            parsePreparedVideoSend(data.request),
                            (ids: readonly string[]) => allocation.record(ids),
                        );
                    } finally {
                        allocation.close();
                    }
                },
            };
            const request = parsePreparedVideoSend({
                profile: 'SELF1234',
                chatId: 'c:ABCD1234',
                token,
                fileName: metadata.fileName,
                mediaType: metadata.mediaType,
                durationSeconds: metadata.durationSeconds,
                width: metadata.dimensions.width,
                height: metadata.dimensions.height,
                ...(withThumbnail
                    ? {
                          thumbnailToken: thumbnail,
                          thumbnailMediaType: 'image/jpeg',
                          thumbnailWidth: 256,
                          thumbnailHeight: 144,
                      }
                    : {}),
            });
            await assert.rejects(
                runtime.sendNodePreparedVideo(
                    backend,
                    {...request, profile: 'OTHER123'},
                    async () => {},
                ),
            );
            await assert.rejects(
                runtime.sendNodePreparedVideo(
                    backend,
                    {...request, durationSeconds: 0},
                    async () => {},
                ),
            );
            let allocated: readonly string[] = [];
            const ids = await BackendController.prototype.sendPreparedVideo.call(
                outer as any,
                request,
                async (values) => {
                    assert.equal(sent.length, 0);
                    recorded = true;
                    allocated = [...values];
                },
            );
            assert.deepEqual(ids, allocated);
            assert.match(ids[0]!, /^m:[a-f0-9]{16}$/);

            assert.equal(ids.length, 1);
            assert.equal(sent.length, 1);
            assert.equal(sent[0].type, 'video');
            assert.equal(sent[0].duration, 1.25);
            assert.deepEqual(sent[0].dimensions, {width: 640, height: 360});
            assert.deepEqual(Buffer.from(await storage.load(sent[0].fileData)), Buffer.from('abc'));
            if (withThumbnail)
                assert.deepEqual(
                    Buffer.from(await storage.load(sent[0].thumbnailFileData)),
                    Buffer.from('abc'),
                );
            else assert.equal(sent[0].thumbnailFileData, undefined);
            await assert.rejects(
                proxy.sendPreparedVideoWithIds(token, thumbnail, metadata, recorder()),
            );
            const uncertain = await registry.prepare('c:ABCD1234', source(), 3);
            await assert.rejects(
                proxy.sendPreparedVideoWithIds(
                    uncertain,
                    undefined,
                    {
                        fileName: 'uncertain.mp4',
                        mediaType: 'video/mp4',
                        durationSeconds: 1,
                        dimensions: {width: 16, height: 16},
                    },
                    recorder(true),
                ),
            );
            assert.equal(sent.length, 1);
            assert.throws(() => registry.claim(uncertain, 'c:ABCD1234'));
        } finally {
            proxy[runtime.ProbeReleaseProxy]();
            pair.local.close();
            pair.remote.close();
            await registry.close();
            await rm(directory, {recursive: true, force: true});
        }
    });
