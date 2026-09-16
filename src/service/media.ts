import {access, constants} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {ServiceConfig} from './config.ts';
import type {MatrixSession} from './matrix-session.ts';
import type {ProfileRuntimeOptions} from './profile-runtime.ts';
import type {BackendController} from '../threema/backend-controller.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import {createBackendMediaRenderer} from '../media/backend-renderer.ts';
import {createFilePreparation} from '../media/file-preparation.ts';
import {createImagePreparation} from '../media/image-preparation.ts';
import {createAudioPreparation} from '../media/audio-staging.ts';
import {createVideoPreparation} from '../media/video-download.ts';
import {UploadLimits} from '../media/upload-limits.ts';
import {MimePolicy} from '../media/mime-policy.ts';

/** Assemble the personal media feature without enabling mutations or other feature loops. */
export async function createServiceMedia(
    config: ServiceConfig,
    backend: BackendController,
    matrix: MatrixSession,
    portals: PortalStore,
    signal: AbortSignal,
    applicationToken: string,
): Promise<Pick<ProfileRuntimeOptions, 'files' | 'renderMedia' | 'renderOwnerMedia'>> {
    const tools = config.media.tools;
    if (!tools) throw new Error('Media tool configuration is required');
    await Promise.all(
        [...Object.values(tools), join(dirname(tools.ffmpeg), 'ffprobe')].map((file) =>
            access(file, constants.X_OK),
        ),
    );
    signal.throwIfAborted();
    const client = matrix.bot.underlyingClient;
    const limits = new UploadLimits(client, () => backend.mediaLimits(), config.media.maximumBytes);
    const policy = new MimePolicy();
    const common = {
        client: {
            homeserverUrl: client.homeserverUrl,
            accessToken: applicationToken,
            doesServerSupportVersion: client.doesServerSupportVersion.bind(client),
            contentScannerInstance: client.contentScannerInstance,
        },
        userId: await client.getUserId(),
        directory: config.media.temporaryDirectory,
        maximumBytes: () => limits.get(),
        verifyMime: (header: Buffer, declared: string) => policy.verify(header, declared),
        backend,
    };
    const codec = {
        limiter: tools.limiter,
        executable: tools.ffmpeg,
        cpuSeconds: 120,
        memoryBytes: 2 * 1024 ** 3,
        timeoutMs: 180000,
    };
    const renderer = await createBackendMediaRenderer({
        profile: config.identity,
        backend,
        store: portals,
        temporaryDirectory: config.media.temporaryDirectory,
        bot: matrix.bot,
        maximumBytes: config.media.maximumBytes,
        signal,
    });
    const renderMedia = renderer.render.bind(renderer);
    return {
        renderMedia,
        // The personal runtime reconciles owner roots and skips all caption edits.
        renderOwnerMedia: renderMedia,
        files: {
            maximumBytes: config.media.maximumBytes,
            createPreparation: (signal) => createFilePreparation({...common, signal}),
            createImagePreparation: (signal) =>
                createImagePreparation({
                    ...common,
                    signal,
                    codec: {
                        ...codec,
                        jpegExecutable: tools.jpeg,
                        webpExecutable: tools.webp,
                        avifExecutable: tools.avif,
                        maximumSide: 4096,
                        maximumPixels: 40000000,
                        thumbnailSide: 256,
                        maximumThumbnailBytes: 1024 ** 2,
                    },
                }),
            createAudioPreparation: (signal) =>
                createAudioPreparation({
                    ...common,
                    signal,
                    codec: {...codec, maximumDurationSeconds: 10000},
                }),
            createVideoPreparation: (signal) =>
                createVideoPreparation({
                    ...common,
                    signal,
                    codec: {...codec, avcEncoder: config.media.avcEncoder},
                    inspection: {
                        ...codec,
                        executable: process.execPath,
                        maximumDurationSeconds: 10000,
                        maximumReadBytes: 256 * 1024 ** 2,
                    },
                    thumbnail: {jpegExecutable: tools.jpeg, maximumThumbnailBytes: 1024 ** 2},
                }),
        },
    };
}
