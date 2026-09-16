import {
    Backend,
    BackendCreationError,
    type BackendInit,
    type CertificatePinRecoveryHandle,
    type LoadingState,
    type LoadingStateSetup,
} from '~/common/dom/backend';
import {createEndpointService} from '~/common/dom/utils/endpoint';
import {TRANSFER_HANDLER} from '~/common/index';
import {NOOP_LOGGER} from '~/common/logging';
import {PROXY_HANDLER, type ProxyMarked, type ProxyEndpoint} from '~/common/utils/endpoint';
import {WritableStore} from '~/common/utils/store';

import {createNodeFactories} from './node-factories';
import {createNodePlatform} from './node-platform';

/** Exercises the real Backend initialization and key-storage error mapping on an empty profile. */
export async function probeMissingProfile(profileDirectory: string): Promise<string> {
    const logging = {logger: () => NOOP_LOGGER};
    const endpoint = createEndpointService({logging});
    const close: (() => void)[] = [];
    function expose<T extends ProxyMarked>(value: T): ProxyEndpoint<T> {
        const pair = endpoint.createEndpointPair<T>();
        close.push(
            () => pair.local.close?.(),
            () => pair.remote.close?.(),
        );
        endpoint.exposeProxy(value, pair.local);
        return pair.remote as ProxyEndpoint<T>;
    }
    const platform = createNodePlatform();
    let os: 'linux' | 'macos' | 'windows' | 'other' = 'other';
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
    const loading: LoadingStateSetup = {
        [TRANSFER_HANDLER]: PROXY_HANDLER,
        loadingState: {
            [TRANSFER_HANDLER]: PROXY_HANDLER,
            store: new WritableStore<LoadingState>({state: 'pending'}),
            updateState: () => undefined,
        },
    };
    const recovery = endpoint.createEndpointPair<CertificatePinRecoveryHandle>();
    close.push(
        () => recovery.local.close?.(),
        () => recovery.remote.close?.(),
    );
    try {
        await Backend.createFromKeyStorage(
            init,
            createNodeFactories(profileDirectory),
            {endpoint, logging},
            'synthetic-unused-password',
            expose(loading),
            recovery.local,
        );
        throw new Error('Empty profile unexpectedly opened');
    } catch (error) {
        if (error instanceof BackendCreationError) {
            return error.type;
        }
        throw error;
    } finally {
        for (const cleanup of close) {
            cleanup();
        }
    }
}
