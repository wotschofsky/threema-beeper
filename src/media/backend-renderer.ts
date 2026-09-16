import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {BackendController} from '../threema/backend-controller.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import {describeBackendMedia} from './backend-media.ts';
import {MediaRenderer} from './media-renderer.ts';
import {MediaTransfer} from './media-transfer.ts';
import {UploadLimits} from './upload-limits.ts';
import {MimePolicy} from './mime-policy.ts';

/** Wire retained backend media, protected upload recovery and content sniffing for the journal sink. */
export async function createBackendMediaRenderer(options: {
    profile: string;
    backend: Pick<BackendController, 'mediaInfo' | 'mediaStream' | 'mediaLimits'>;
    store: PortalStore;
    temporaryDirectory: string;
    bot: {enableEncryption(): Promise<void>; underlyingClient: MatrixClient};
    /** Local cap; discovery also enforces the Matrix and pinned Threema limits. */
    maximumBytes: number;
    fileExecutable?: string;
    signal?: AbortSignal;
}): Promise<MediaRenderer> {
    if (
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(options.profile) ||
        !Number.isSafeInteger(options.maximumBytes) ||
        options.maximumBytes < 1 ||
        options.maximumBytes > 1024 ** 3
    )
        throw new Error('Invalid backend media configuration');
    options.signal?.throwIfAborted();
    const transfer = new MediaTransfer(options.store, options.temporaryDirectory);
    await transfer.initialize();
    options.signal?.throwIfAborted();
    const policy = new MimePolicy(options.fileExecutable);
    await options.bot.enableEncryption();
    options.signal?.throwIfAborted();
    const limits = new UploadLimits(
        options.bot.underlyingClient,
        () => options.backend.mediaLimits(),
        options.maximumBytes,
    );
    return new MediaRenderer({
        profile: options.profile,
        transfer,
        client: options.bot.underlyingClient,
        describe: async (message, part) =>
            describeBackendMedia(
                options.backend,
                message,
                part,
                await limits.get(),
                options.signal,
            ),
        maxBytes: () => limits.get(),
        verifyMime: (header, declared) => policy.verify(header, declared),
        signal: options.signal,
    });
}
