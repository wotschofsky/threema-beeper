/* eslint-disable @typescript-eslint/require-await -- RPC contracts are async even for locally rejected operations. */
import type {IFrontendElectronService} from '~/common/electron-service';
import {TRANSFER_HANDLER} from '~/common/index';
import type {IFrontendMediaService} from '~/common/media';
import type {NotificationCreator} from '~/common/notification';
import type {SystemDialogService} from '~/common/system-dialog';
import {PROXY_HANDLER} from '~/common/utils/endpoint';
import type {WebRtcService} from '~/common/webrtc';
import {dismissConnectionDialog, type ConnectionIssue} from './node-connection-issue';

export class UnsupportedHeadlessOperation extends Error {
    public readonly code = 'UNSUPPORTED_HEADLESS_OPERATION';
}
function unsupported(): never {
    throw new UnsupportedHeadlessOperation(
        'This operation requires an unsupported desktop service',
    );
}

/** Explicit consumer-build services. Security decisions and destructive UI operations never auto-accept. */
export function createNodePlatform(reportConnectionIssue: (issue: ConnectionIssue) => void = () => undefined): {
    readonly electron: IFrontendElectronService;
    readonly media: IFrontendMediaService;
    readonly notifications: NotificationCreator;
    readonly dialogs: SystemDialogService;
    readonly webrtc: WebRtcService;
} {
    const open: SystemDialogService['open'] = dialog => {
        const handle = dismissConnectionDialog(dialog, reportConnectionIssue);
        if (!handle) return unsupported();
        return {...handle, [TRANSFER_HANDLER]: PROXY_HANDLER};
    };
    return {
        electron: {
            [TRANSFER_HANDLER]: PROXY_HANDLER,
            updatePublicKeyPins: async () => unsupported(),
            removeOldProfiles: unsupported,
            restartAppAndInstallUpdate: unsupported,
            logToFile: async () => undefined,
            restartApp: unsupported,
            getRemoteSecretLaunchParameter: () => undefined,
            remoteSecretErrorRestartApp: unsupported,
            remoteSecretSystemSuspensionRestartApp: unsupported,
            remoteSecretSystemSuspensionRestartParameter: () => false,
            checkOppFile: async () => unsupported(),
            getOppFile: async () => unsupported(),
            checkFallbackOppFile: async () => unsupported(),
            getFallbackOppFile: async () => unsupported(),
            beforeRestart: async () => unsupported(),
            registerInvalidCertificatePins: unsupported,
            triggerInvalidCertificatePins: async () => unsupported(),
            signalRestartReady: async () => unsupported(),
        },
        media: {
            [TRANSFER_HANDLER]: PROXY_HANDLER,
            generateImageThumbnail: async () => unsupported(),
            generateVideoThumbnail: async () => unsupported(),
            refreshThumbnailCacheForMessage: () => undefined,
        },
        notifications: {
            [TRANSFER_HANDLER]: PROXY_HANDLER,
            create: () => undefined,
            update: () => undefined,
        },
        dialogs: {
            [TRANSFER_HANDLER]: PROXY_HANDLER,
            closeAll: () => undefined,
            open,
            openOnce: open,
        },
        webrtc: {[TRANSFER_HANDLER]: PROXY_HANDLER, createGroupCallContext: unsupported},
    };
}
