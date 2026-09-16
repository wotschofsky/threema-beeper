import {parentPort, workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {randomFillSync, createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
    serveBackendSession,
    type BackendSession,
} from '../../src/threema/backend-session-router.ts';

// Only profile/model state is synthetic. Routing, streams, native storage/controller and proxy are real.
const runtime = createRequire(import.meta.url)(
    '../../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
const port = parentPort!;
const endpoint = runtime.ProbeEndpointService({logging: {logger: () => runtime.ProbeNoopLogger}});
const crypto = {randomBytes: (bytes: Uint8Array) => randomFillSync(bytes)};
const storage = new runtime.ProbeFileStorage(
    {crypto},
    runtime.ProbeNoopLogger,
    workerData.profileDirectory,
);
const registry = new runtime.NodePreparedFiles(storage, 1048576);
storage.preparedFiles = registry;
let persisted = false;
const report: unknown[] = [];
const controller = Object.assign(Object.create(runtime.ProbeSendController.prototype), {
    _services: {crypto, file: storage, device: {identity: {string: 'SELF1234'}}},
    _log: runtime.ProbeNoopLogger,
    _conversation: {
        get: () => ({
            controller: {
                receiver: () => ({
                    get: () => ({
                        type: runtime.ProbeReceiverType.CONTACT,
                        view: {identity: 'ABCD1234'},
                    }),
                }),
                addMessage: {
                    fromLocal: async (message: any) => {
                        if (!persisted) throw new Error('Native send preceded persistence');
                        const digest = async (handle: unknown) =>
                            createHash('sha256')
                                .update(Buffer.from(await storage.load(handle)))
                                .digest('hex');
                        report.push({
                            type: message.type,
                            duration: message.duration,
                            dimensions: message.dimensions,
                            main: await digest(message.fileData),
                            thumbnail: message.thumbnailFileData
                                ? await digest(message.thumbnailFileData)
                                : null,
                        });
                        await writeFile(
                            join(workerData.profileDirectory, 'sent.json'),
                            JSON.stringify(report),
                        );
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
                return await controller.sendPreparedVideoWithIds(token, thumbnail, metadata, hook);
            } finally {
                hook[runtime.ProbeReleaseProxy]();
            }
        },
    },
    pair.local,
);
const proxy = endpoint.wrap(pair.remote, runtime.ProbeNoopLogger);
const handle = {
    model: {
        user: {identity: 'SELF1234'},
        conversations: {getAll: async () => ({get: () => new Set([controller._conversation])})},
    },
    viewModel: {conversation: async () => ({viewModelController: proxy})},
};
const own = (profile: string) => {
    if (profile !== 'SELF1234') throw new Error('Wrong profile');
};
const implemented: Partial<BackendSession> = {
    identity: async () => 'SELF1234',
    prepareFile: async (request, source) => {
        own(request.profile);
        return registry.prepare(request.chatId, source, request.bytes);
    },
    discardPreparedFile: async (request) => {
        own(request.profile);
        return registry.discard(request.token, request.chatId);
    },
    sendPreparedVideo: async (request, persist) => {
        persisted = false;
        return runtime.sendNodePreparedVideo(handle, request, async (ids: readonly string[]) => {
            await persist(ids);
            persisted = true;
        });
    },
    closePreparedFiles: async () => {
        await registry.close();
        proxy[runtime.ProbeReleaseProxy]();
        pair.local.close();
        pair.remote.close();
    },
};
const session = new Proxy(implemented, {
    get: (target, key: keyof BackendSession) =>
        target[key] ??
        (async () => {
            throw new Error('Unused synthetic session operation');
        }),
}) as BackendSession;
serveBackendSession(port, session, () => ({maximumBytes: 1048576}));
