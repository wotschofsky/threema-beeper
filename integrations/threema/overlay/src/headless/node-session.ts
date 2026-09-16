import {markNodeRead} from './node-read';
import {readNodeProfilePicture} from './node-profile-picture';
import {watchNodeTyping} from './node-incoming-typing';
import {ConnectionState} from '~/common/enum';
import {setNodeTyping} from './node-typing';
import type {NodeTypingRequest} from './node-typing-request';
import {mutateNodeMessage, readNodeMutation, type NodeMutationRequest} from './node-mutation';
import {sendNodePreparedVideo, type NodePreparedVideoSend} from './node-send-prepared-video';
import {sendNodePreparedImage, type NodePreparedImageSend} from './node-send-prepared-image';
import {sendNodePreparedFile, type NodePreparedFileSend} from './node-send-prepared-file';
import type {ReadonlyUint8Array} from '@threema/ts-utils/array/readonly-uint8-array';
import {NodePreparedFiles} from './node-prepared-files';
import {prepareNodeFile, type NodePrepareFile} from './node-prepare-file';

import {ResolvablePromise} from '@threema/ts-utils/promise/resolvable-promise';

import {
    Backend,
    type BackendHandle,
    type BackendInit,
    type CertificatePinRecoveryHandle,
    type DeviceLinkingSetup,
    type LinkingState,
    type LoadingState,
    type LoadingStateSetup,
} from '~/common/dom/backend';
import {createEndpointService} from '~/common/dom/utils/endpoint';
import {TRANSFER_HANDLER} from '~/common/index';
import {NOOP_LOGGER} from '~/common/logging';
import type {FileSystemFileStorage} from '~/common/node/file-storage/system-file-storage';
import {
    PROXY_HANDLER,
    type ProxyMarked,
    type ProxyEndpoint,
    type RemoteProxy,
} from '~/common/utils/endpoint';
import {eternalPromise, ReusablePromise} from '~/common/utils/promise';
import {WritableStore} from '~/common/utils/store';

import {listNodeConversations} from './node-conversations';
import {readNodeDirectory} from './node-directory';
import {ensureNodeContact} from './node-contact';
import {reactNodeMessage, readNodeReaction, type NodeReactionRequest} from './node-reaction';
import {createNodeFactories} from './node-factories';
import {readNodeHistoryPage, type HistoryCursor, type HistoryPage} from './node-history';
import {watchNodeMessages} from './node-live-messages';
import {resolveNodeMedia, type NodeMediaRequest, type NodeMediaSource} from './node-media';
import type {NormalizedNodeMessage} from './node-message-types';
import {createNodePlatform} from './node-platform';
import type {ConnectionIssue} from './node-connection-issue';
import {sendNodeText, type NodeTextSend} from './node-send';
import {watchNodeTopology} from './node-topology';

export interface NodeBackendSession {
    readonly markRead: (request: {
        profile: string;
        chatId: string;
        messageId: string;
    }) => Promise<void>;
    readonly setTyping: (request: NodeTypingRequest) => Promise<void>;
    readonly mutationState: (request: NodeMutationRequest) => Promise<boolean>;
    readonly mutateMessage: (request: NodeMutationRequest) => Promise<void>;
    readonly discardPreparedFile: (request: {
        profile: string;
        chatId: string;
        token: string;
    }) => Promise<boolean>;
    readonly sendPreparedVideo: (
        request: NodePreparedVideoSend,
        beforeSend: (ids: readonly string[]) => Promise<void>,
    ) => Promise<readonly string[]>;
    readonly sendPreparedImage: (
        request: NodePreparedImageSend,
        beforeSend: (ids: readonly string[]) => Promise<void>,
    ) => Promise<readonly string[]>;
    readonly sendPreparedFile: (
        request: NodePreparedFileSend,
        beforeSend: (ids: readonly string[]) => Promise<void>,
    ) => Promise<readonly string[]>;
    readonly prepareFile: (
        request: NodePrepareFile,
        source: AsyncIterable<ReadonlyUint8Array>,
        signal?: AbortSignal,
    ) => Promise<string>;
    readonly closePreparedFiles: () => Promise<void>;
    readonly sendText: (
        request: NodeTextSend,
        beforeSend: (ids: readonly string[]) => Promise<void>,
    ) => Promise<readonly string[]>;
    readonly media: (request: NodeMediaRequest, signal?: AbortSignal) => Promise<NodeMediaSource>;
    readonly open: (password: string) => Promise<void>;
    readonly link: () => Promise<void>;
    readonly providePassword: (password: string) => void;
    readonly getHandle: () => RemoteProxy<BackendHandle>;
    readonly identity: () => Promise<string>;
    readonly conversations: () => ReturnType<typeof listNodeConversations>;
    readonly directory: () => ReturnType<typeof readNodeDirectory>;
    readonly profilePicture: (identity: string) => Promise<Uint8Array | null>;
    readonly ensureContact: (identity: string) => ReturnType<typeof ensureNodeContact>;
    readonly reactMessage: (request: NodeReactionRequest) => Promise<void>;
    readonly reactionState: (request: NodeReactionRequest) => Promise<boolean>;
    readonly watchTyping: (
        chatId: string,
        changed: (typing: boolean) => void,
    ) => Promise<() => Promise<void>>;
    readonly watchConnection: (
        changed: (connected: boolean) => void,
    ) => Promise<() => Promise<void>>;
    readonly watchTopology: (onReset: () => void) => Promise<() => Promise<void>>;
    readonly history: (
        chatId: string,
        limit: number,
        after?: HistoryCursor,
    ) => Promise<HistoryPage>;
    readonly watchMessages: (
        chatId: string,
        consume: (message: NormalizedNodeMessage) => Promise<void>,
        onReset: () => void,
    ) => Promise<() => Promise<void>>;
    /** Releases IPC endpoints after a failed initialization. Active backends require worker termination. */
    readonly closeEndpoints: () => void;
}

/** Own exactly one session per worker. Cancel by terminating that worker, not by closing only IPC. */
export function createNodeSession(
    profileDirectory: string,
    onLinkingState: (state: LinkingState) => void,
    onLoadingState: (state: LoadingState) => void,
    onConnectionIssue: (issue: ConnectionIssue) => void = () => undefined,
): NodeBackendSession {
    let fileStorage: FileSystemFileStorage | undefined;
    let preparedFiles: NodePreparedFiles | undefined;
    let preparationClosed = false;
    const factories = createNodeFactories(profileDirectory, (storage) => {
        fileStorage = storage;
        if (!preparationClosed)
            preparedFiles = new NodePreparedFiles(
                storage,
                Math.min(import.meta.env.MAX_FILE_MESSAGE_BYTES, 1024 ** 3),
            );
        storage.preparedFiles = preparedFiles;
    });
    const logging = {logger: () => NOOP_LOGGER};
    const endpoint = createEndpointService({logging});
    const closers: (() => void)[] = [];
    function expose<T extends ProxyMarked>(value: T): ProxyEndpoint<T> {
        const pair = endpoint.createEndpointPair<T>();
        closers.push(
            () => pair.local.close?.(),
            () => pair.remote.close?.(),
        );
        endpoint.exposeProxy(value, pair.local);
        return pair.remote as ProxyEndpoint<T>;
    }
    const platform = createNodePlatform(onConnectionIssue);
    let os: BackendInit['systemInfo']['os'] = 'other';
    if (process.platform === 'darwin') {
        os = 'macos';
    }
    if (process.platform === 'linux') {
        os = 'linux';
    }
    if (process.platform === 'win32') {
        os = 'windows';
    }
    const init: BackendInit = {
        electronEndpoint: expose(platform.electron),
        mediaEndpoint: expose(platform.media),
        notificationEndpoint: expose(platform.notifications),
        systemDialogEndpoint: expose(platform.dialogs),
        webRtcEndpoint: expose(platform.webrtc),
        systemInfo: {os, arch: process.arch, locale: 'en', isSafeStorageAvailable: false},
    };
    let started = false;
    let closed = false;
    let handle: RemoteProxy<BackendHandle> | undefined;
    let linkingState: LinkingState = {state: 'initializing'};
    const password = new ResolvablePromise<string>({uncaught: 'discard'});
    function begin(): void {
        if (started || closed) {
            throw new Error('A headless worker can initialize only one backend');
        }
        started = true;
    }
    function setLocalHandle(local: BackendHandle): void {
        // Adapters await native methods, including synchronous local results.
        // Raw model views contain live stores and cannot be structured-cloned.
        // Only normalized records cross the outer BackendController worker boundary.
        handle = local as unknown as RemoteProxy<BackendHandle>;
    }
    function saveHandle(remote: ProxyEndpoint<BackendHandle>): void {
        closers.push(() => remote.close?.());
        if (handle === undefined) throw new Error('Local backend handle was not provided');
    }
    return {
        discardPreparedFile: async (request) => {
            request = {...request};
            if (
                handle === undefined ||
                closed ||
                preparedFiles === undefined ||
                preparationClosed ||
                !/^[a-f0-9]{64}$/u.test(request.token) ||
                (await handle.model.user.identity) !== request.profile
            ) {
                throw new Error('Prepared file is unavailable');
            }
            return await preparedFiles.discard(request.token, request.chatId);
        },
        markRead: async (request) => {
            if (handle === undefined || closed) throw new Error('Headless backend is not ready');
            await markNodeRead(handle, request);
        },
        sendPreparedFile: async (request, beforeSend) => {
            if (handle === undefined || closed || preparationClosed)
                throw new Error('Headless backend is not ready');
            return await sendNodePreparedFile(handle, request, beforeSend);
        },
        sendPreparedVideo: async (request, beforeSend) => {
            if (handle === undefined || closed || preparationClosed)
                throw new Error('Headless backend is not ready');
            return await sendNodePreparedVideo(handle, request, beforeSend);
        },
        sendPreparedImage: async (request, beforeSend) => {
            if (handle === undefined || closed || preparationClosed)
                throw new Error('Headless backend is not ready');
            return await sendNodePreparedImage(handle, request, beforeSend);
        },
        prepareFile: async (request, source, signal) => {
            if (handle === undefined || closed || preparedFiles === undefined)
                throw new Error('Headless backend is not ready');
            return await prepareNodeFile(handle, preparedFiles, request, source, signal);
        },
        closePreparedFiles: async () => {
            preparationClosed = true;
            await preparedFiles?.close();
        },
        sendText: async (request, beforeSend) => {
            if (handle === undefined || closed) {
                throw new Error('Headless backend is not ready');
            }
            return await sendNodeText(handle, request, beforeSend);
        },
        open: async (secret) => {
            begin();
            const loadingStore = new WritableStore<LoadingState>({state: 'pending'});
            const loading: LoadingStateSetup = {
                [TRANSFER_HANDLER]: PROXY_HANDLER,
                loadingState: {
                    [TRANSFER_HANDLER]: PROXY_HANDLER,
                    store: loadingStore,
                    updateState: (state) => {
                        loadingStore.set(state);
                        onLoadingState(state);
                    },
                },
            };
            const recovery = endpoint.createEndpointPair<CertificatePinRecoveryHandle>();
            closers.push(
                () => recovery.local.close?.(),
                () => recovery.remote.close?.(),
            );
            saveHandle(
                await Backend.createFromKeyStorage(
                    init,
                    factories,
                    {endpoint, logging},
                    secret,
                    expose(loading),
                    recovery.local,
                    setLocalHandle,
                ),
            );
        },
        link: async () => {
            begin();
            if (factories.hasIdentity()) {
                throw new Error('Refusing to link over an existing identity');
            }
            const store = new WritableStore<LinkingState>(linkingState);
            const setup: DeviceLinkingSetup = {
                [TRANSFER_HANDLER]: PROXY_HANDLER,
                linkingState: {
                    [TRANSFER_HANDLER]: PROXY_HANDLER,
                    store,
                    updateState: (state) => {
                        linkingState = state;
                        store.set(state);
                        onLinkingState(state);
                    },
                },
                userPassword: password,
                oldProfilePassword: new ReusablePromise<string | undefined>(),
                continueWithoutRestoring: eternalPromise(),
                oppfConfig: eternalPromise(),
            };
            saveHandle(
                await Backend.createFromDeviceJoin(
                    init,
                    factories,
                    {endpoint, logging},
                    expose(setup),
                    false,
                    setLocalHandle,
                ),
            );
        },
        providePassword: (secret) => {
            if (closed || linkingState.state !== 'waiting-for-password' || password.done) {
                throw new Error('Linking is not waiting for a password');
            }
            if (secret.length < 32) {
                throw new Error('A generated profile secret is required');
            }
            password.resolve(secret);
        },
        profilePicture: async (identity) => {
            if (handle === undefined || closed) throw new Error('Headless backend is not ready');
            return await readNodeProfilePicture(handle, identity);
        },
        directory: async () => {
            if (handle === undefined || closed) {
                throw new Error('Headless backend is not ready');
            }
            return await readNodeDirectory(handle);
        },
        ensureContact: async (identity) => {
            if (handle === undefined || closed) throw new Error('Headless backend is not ready');
            return await ensureNodeContact(handle, identity);
        },
        setTyping: async (request) => {
            if (closed || !handle) throw new Error('Backend profile is not open');
            await setNodeTyping(handle, request);
        },
        mutationState: async (request) => {
            if (handle === undefined || closed) throw new Error('Headless backend is not ready');
            return await readNodeMutation(handle, request);
        },
        mutateMessage: async (request) => {
            if (handle === undefined || closed) throw new Error('Headless backend is not ready');
            await mutateNodeMessage(handle, request);
        },
        reactMessage: async (request) => {
            if (handle === undefined || closed) throw new Error('Headless backend is not ready');
            await reactNodeMessage(handle, request);
        },
        reactionState: async (request) => {
            if (handle === undefined || closed) throw new Error('Headless backend is not ready');
            return await readNodeReaction(handle, request);
        },
        watchTyping: async (chatId, changed) => {
            if (handle === undefined || closed) throw new Error('Headless backend is not ready');
            return await watchNodeTyping(handle, chatId, changed);
        },
        watchConnection: async (changed) => {
            if (handle === undefined || closed) throw new Error('Headless backend is not ready');
            const state = await handle.connectionManager.state;
            const unsubscribe = state.subscribe((value) =>
                changed(value === ConnectionState.CONNECTED),
            );
            return async () => {
                unsubscribe();
            };
        },
        watchTopology: async (onReset) => {
            if (handle === undefined || closed) {
                throw new Error('Headless backend is not ready');
            }
            return await watchNodeTopology(handle, onReset);
        },
        watchMessages: async (chatId, consume, onReset) => {
            if (handle === undefined || closed) {
                throw new Error('Headless backend is not ready');
            }
            return await watchNodeMessages(handle, chatId, consume, onReset);
        },
        history: async (chatId, limit, after) => {
            if (handle === undefined || closed) {
                throw new Error('Headless backend is not ready');
            }
            return await readNodeHistoryPage(handle, chatId, limit, after);
        },
        media: async (request, signal) => {
            if (handle === undefined || closed || fileStorage === undefined) {
                throw new Error('Headless backend is not ready');
            }
            return await resolveNodeMedia(handle, fileStorage, request, signal);
        },
        conversations: async () => {
            if (handle === undefined || closed) {
                throw new Error('Headless backend is not ready');
            }
            return await listNodeConversations(handle);
        },
        identity: async () => {
            if (handle === undefined || closed) {
                throw new Error('Headless backend is not ready');
            }
            return await handle.model.user.identity;
        },
        getHandle: () => {
            if (handle === undefined || closed) {
                throw new Error('Headless backend is not ready');
            }
            return handle;
        },
        closeEndpoints: () => {
            if (closed) {
                return;
            }
            closed = true;
            for (const close of closers) {
                close();
            }
        },
    };
}
