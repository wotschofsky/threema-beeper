export {mutateNodeMessage, readNodeMutation} from './node-mutation';
export {OutboundTextMessageModelStore as ProbeOutboundTextStore} from '~/common/model/message/text-message';
export {ConversationModelStore as ProbeConversationStore} from '~/common/model/conversation';
export {OutgoingEditMessageTask as ProbeOutgoingEditTask} from '~/common/network/protocol/task/csp/outgoing-edit-message';
export {OutgoingDeleteMessageTask as ProbeOutgoingDeleteTask} from '~/common/network/protocol/task/csp/outgoing-delete-message';
export {OutgoingCspMessagesTask as ProbeOutgoingCspTask} from '~/common/network/protocol/task/csp/outgoing-csp-messages';
export * as ProbeMutationProtobuf from '~/common/network/protobuf';
export * as ProbeMutationStructbuf from '~/common/network/structbuf';
export {
    CspE2eMessageUpdateType as ProbeMutationType,
    CspE2eGroupMessageUpdateType as ProbeGroupMutationType,
} from '~/common/enum';
import {readFile} from 'node:fs/promises';
export {ensureNodeContact} from './node-contact';
export {reactNodeMessage, readNodeReaction} from './node-reaction';

import initLibthreema, * as libthreema from '@threema/libthreema-wasm';

import {Backend} from '~/common/dom/backend';
import {NOOP_LOGGER} from '~/common/logging';
import {getIsAnyKeyStorageFilePresent} from '~/common/node/key-storage/helpers';

/**
 * Keep the real backend reachable in the import probe. A successful import does
 * not establish that its linking, services, or connection lifecycle work.
 */
export const backend = Backend;

let initialization: Promise<void> | undefined;

export async function probe(
    wasmFile: string,
    emptyProfilePath: string,
): Promise<{
    readonly node: string;
    readonly wasmInitialized: boolean;
    readonly hasIdentity: boolean;
}> {
    initialization ??= (async () => {
        // Upstream DOM helpers use self.crypto; Node exposes the same Web Crypto API on globalThis.
        if (!Object.hasOwn(globalThis, 'self')) {
            Object.defineProperty(globalThis, 'self', {value: globalThis, configurable: true});
        }
        await initLibthreema({
            // Wasm-bindgen owns this initialization property name.
            // eslint-disable-next-line @typescript-eslint/naming-convention
            module_or_path: await readFile(wasmFile),
        });
        libthreema.init(
            {handle: () => undefined},
            {
                debug: () => undefined,
                info: () => undefined,
                warn: () => undefined,
                error: () => undefined,
            },
            'info',
        );
    })();
    await initialization;
    const hasIdentity = Backend.hasIdentity(
        {hasIdentity: () => getIsAnyKeyStorageFilePresent(emptyProfilePath)},
        {logging: {logger: () => NOOP_LOGGER}},
    );
    return {node: process.version, wasmInitialized: true, hasIdentity};
}

export {createNodeFactories} from './node-factories';

export {probeMissingProfile} from './open-profile-probe';
export {createNodePlatform} from './node-platform';

export {probeProfileDatabase} from './database-probe';

export {createNodeSession} from './node-session';
export {listNodeConversations} from './node-conversations';
export {watchNodeModels} from './node-watch';
export {normalizeNodeMessage} from './node-message';
export {readNodeHistoryPage} from './node-history';
export {watchNodeMessages} from './node-live-messages';
export {watchNodeTopology} from './node-topology';
export {readNodeDirectory} from './node-directory';
export {WritableStore as ProbeWritableStore} from '~/common/utils/store';
export {LocalSetStore as ProbeSetStore} from '~/common/utils/store/set-store';
export {openNodeStoredFile, describeNodeStoredFile} from './node-file-stream';
export {FileSystemFileStorage as ProbeFileStorage} from '~/common/node/file-storage/system-file-storage';

export {resolveNodeMedia} from './node-media';

export function getNodeMediaLimits(): {maximumBytes: number} {
    return {maximumBytes: import.meta.env.MAX_FILE_MESSAGE_BYTES};
}

export {InboundFileMessageModelController as ProbeFileController} from '~/common/model/message/file-message';

export {ConversationViewModelController as ProbeSendController} from '~/common/viewmodel/conversation/main/controller';

export {sendNodeText} from './node-send';
export {createEndpointService as ProbeEndpointService} from '~/common/dom/utils/endpoint';
export {NOOP_LOGGER as ProbeNoopLogger} from '~/common/logging';
export {TRANSFER_HANDLER as ProbeTransferHandler} from '~/common/index';
export {PROXY_HANDLER as ProbeProxyHandler} from '~/common/utils/endpoint';
export {RELEASE_PROXY as ProbeReleaseProxy} from '~/common/index';
export {
    ReceiverType as ProbeReceiverType,
    ConnectionState as ProbeConnectionState,
    GroupUserState as ProbeGroupUserState,
} from '~/common/enum';

export {NodePreparedFiles} from './node-prepared-files';

export {prepareNodeFile} from './node-prepare-file';

export {sendNodePreparedFile} from './node-send-prepared-file';

export {sendNodePreparedImage} from './node-send-prepared-image';

export {sendNodePreparedVideo} from './node-send-prepared-video';

export {setNodeTyping} from './node-typing';

export {watchNodeTyping} from './node-incoming-typing';

export {readNodeProfilePicture} from './node-profile-picture';

export {markNodeRead} from './node-read';
export {ConversationModelController as ProbeConversationController} from '~/common/model/conversation';
export {createDefaultConfig as ProbeDefaultConfig} from '~/common/config';
export {wrapRawDatabaseKey as ProbeDatabaseKey} from '~/common/db';
export {getTextForLocation as ProbeLocationText} from '~/common/network/protocol/task/common/location';
