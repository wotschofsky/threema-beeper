import {parentPort, workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {
    serveBackendSession,
    type BackendSession,
} from '../../src/threema/backend-session-router.ts';
const native = createRequire(import.meta.url)(
    '../../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
const services = {
    logging: {logger: () => native.ProbeNoopLogger},
    db: {editMessage: () => {}},
    taskManager: {schedule: async () => {}},
};
const receiver = {
    get: () => ({
        type: native.ProbeReceiverType.CONTACT,
        view: {identity: 'ABCD1234'},
        controller: {conversation: () => conversation},
    }),
};
const store = new native.ProbeOutboundTextStore(
    services,
    {
        id: 1n,
        text: 'original',
        createdAt: new Date(),
        sentAt: new Date(),
        history: [],
        reactions: [],
    },
    1n,
    {uid: 2n, getReceiver: () => receiver},
);
const conversation = {
    get: () => ({
        controller: {
            getMessage: (id: bigint) => (id === 1n ? store : undefined),
            receiver: () => receiver,
            receiverLookup: {type: 0, uid: 2n},
        },
    }),
};
const handle = {
    model: {
        user: {identity: 'SELF1234'},
        conversations: {getAll: async () => ({get: () => new Set([conversation])})},
    },
    viewModel: {
        conversation: async () => ({
            viewModelStore: {
                get: () => ({supportedFeatures: new Map([[0x100n, {supported: true}]])}),
            },
        }),
    },
};
const methods: Partial<BackendSession> = {
    identity: async () => 'SELF1234',
    mutateMessage: async (request) => native.mutateNodeMessage(handle, request),
    mutationState: async (request) =>
        workerData.badStateResponse
            ? ('true' as unknown as boolean)
            : native.readNodeMutation(handle, request),
    closePreparedFiles: async () => {},
};
const session = new Proxy(methods, {
    get: (target, key: keyof BackendSession) =>
        target[key] ??
        (async () => {
            throw new Error('Unused synthetic session operation');
        }),
}) as BackendSession;
serveBackendSession(parentPort!, session, () => ({maximumBytes: 1048576}));
