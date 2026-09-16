import {parseVideoProjection, type VideoProjection} from './video-projection.ts';
import {parsePreparedVideoSend, type PreparedVideoSend} from '../threema/prepared-video-send.ts';
import type {BackendController} from '../threema/backend-controller.ts';
import {parsePreparedFileSend, type PreparedFileSend} from '../threema/prepared-file-send.ts';
import type {MediaJournal, MediaRequest} from './media-journal.ts';
import {parsePreparedImageSend, type PreparedImageSend} from '../threema/prepared-image-send.ts';
import {parseImageProjection, type ImageProjection} from './image-projection.ts';
import {parseAudioProjection, type AudioProjection} from './audio-projection.ts';

/** Durable file dispatch with optional native image/audio preparation. */
export class MediaDispatcher {
    private readonly options: {
        profile: string;
        journal: MediaJournal;
        ready: () => boolean;
        reply?: (request: MediaRequest) => Promise<void>;
        authorize: (request: MediaRequest) => Promise<void>;
        prepare: (
            request: MediaRequest,
        ) => Promise<{request: PreparedFileSend; discard: () => Promise<void>}>;
        backend: Pick<BackendController, 'sendPreparedFile'>;
        audio?: {
            prepare: (request: MediaRequest) => Promise<{
                request: PreparedFileSend;
                projection: AudioProjection;
                discard: () => Promise<void>;
            }>;
        };
        videos?: {
            prepare: (request: MediaRequest) => Promise<{
                request: PreparedVideoSend | PreparedFileSend;
                projection: VideoProjection;
                discard: () => Promise<void>;
            }>;
            send: BackendController['sendPreparedVideo'];
        };
        images?: {
            prepare: (request: MediaRequest) => Promise<{
                request: PreparedImageSend;
                projection: ImageProjection;
                discard: () => Promise<void>;
            }>;
            send: BackendController['sendPreparedImage'];
        };
    };
    private running?: Promise<number>;
    private readonly cleanup = new Map<string, {chat: string; discard: () => Promise<void>}>();
    constructor(options: MediaDispatcher['options']) {
        this.options = options;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid media batch size'));
        this.running ??= this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(limit: number): Promise<number> {
        const {journal, profile, backend} = this.options;
        if (!this.options.ready()) return 0;
        const excluded: string[] = [];
        let sent = 0,
            failed = false;
        for (const [id, pending] of this.cleanup) {
            if (!this.options.ready()) break;
            try {
                await pending.discard();
                this.cleanup.delete(id);
            } catch {
                excluded.push(pending.chat);
                failed = true;
            }
        }
        for (let attempt = 0; attempt < limit && this.options.ready(); attempt++) {
            const candidate = journal.next(profile, excluded);
            if (!candidate) break;
            const request = candidate.request;
            let prepared: Awaited<ReturnType<MediaDispatcher['options']['prepare']>> | undefined;
            let claimed = false;
            let attempted = false;
            try {
                const image = request.media.kind === 'm.image';
                const audio = request.media.kind === 'm.audio';
                const video = request.media.kind === 'm.video';
                if (
                    (!image && !audio && !video && request.media.kind !== 'm.file') ||
                    (image && !this.options.images) ||
                    (audio && !this.options.audio) ||
                    (video && !this.options.videos) ||
                    (request.media.replyTo !== undefined && !this.options.reply)
                )
                    throw new Error('Native media or reply preparation is not available');
                await this.options.authorize(request);
                if (!this.options.ready()) break;
                let projection: ImageProjection | undefined;
                let audioProjection: AudioProjection | undefined;
                let videoProjection: VideoProjection | undefined;
                let invoke: (
                    persist: (ids: readonly string[]) => Promise<void>,
                ) => Promise<readonly string[]>;
                if (image) {
                    const result = await this.options.images!.prepare(request);
                    prepared = result;
                    const command = parsePreparedImageSend(result.request);
                    projection = parseImageProjection(result.projection);
                    if (
                        projection.fileName !== command.fileName ||
                        projection.mediaType !== command.mediaType ||
                        projection.thumbnailMediaType !== command.thumbnailMediaType ||
                        projection.width !== command.width ||
                        projection.height !== command.height ||
                        projection.thumbnailWidth !== command.thumbnailWidth ||
                        projection.thumbnailHeight !== command.thumbnailHeight ||
                        (projection.caption ?? '') !== (command.caption ?? '')
                    )
                        throw new Error('Image command differs from canonical projection');
                    invoke = (persist) => this.options.images!.send(command, persist);
                } else if (video) {
                    const result = await this.options.videos!.prepare(request);
                    prepared = result;
                    videoProjection = parseVideoProjection(result.projection);
                    if (videoProjection.kind === 'video') {
                        const command = parsePreparedVideoSend(result.request);
                        for (const key of [
                            'fileName',
                            'mediaType',
                            'durationSeconds',
                            'width',
                            'height',
                            'thumbnailMediaType',
                            'thumbnailWidth',
                            'thumbnailHeight',
                            'caption',
                        ] as const)
                            if (videoProjection[key] !== command[key])
                                throw new Error('Video command differs from canonical projection');
                        invoke = (persist) => this.options.videos!.send(command, persist);
                    } else {
                        const command = parsePreparedFileSend(result.request);
                        if (
                            command.audioDurationSeconds !== undefined ||
                            command.fileName !== videoProjection.fileName ||
                            command.mediaType !== videoProjection.mediaType ||
                            command.caption !== videoProjection.caption
                        )
                            throw new Error('Video fallback differs from canonical projection');
                        invoke = (persist) => backend.sendPreparedFile(command, persist);
                    }
                } else if (audio) {
                    const result = await this.options.audio!.prepare(request);
                    prepared = result;
                    const command = parsePreparedFileSend(result.request);
                    audioProjection = parseAudioProjection(result.projection);
                    if (
                        audioProjection.fileName !== command.fileName ||
                        audioProjection.mediaType !== command.mediaType ||
                        audioProjection.durationSeconds !== command.audioDurationSeconds ||
                        (audioProjection.caption ?? '') !== (command.caption ?? '')
                    )
                        throw new Error('Audio command differs from canonical projection');
                    invoke = (persist) => backend.sendPreparedFile(command, persist);
                } else {
                    prepared = await this.options.prepare(request);
                    const command = parsePreparedFileSend(prepared.request);
                    if (command.audioDurationSeconds !== undefined)
                        throw new Error('File preparation cannot change message kind');
                    invoke = (persist) => backend.sendPreparedFile(command, persist);
                }
                const send = prepared.request;
                if (send.profile !== profile || send.chatId !== request.media.chat)
                    throw new Error('Prepared media destination conflict');
                if (!this.options.ready()) break;
                // Download and storage can take time; recheck room/source authorization afterward.
                await this.options.authorize(request);
                if (!this.options.ready()) break;
                if (request.media.replyTo) await this.options.reply!(request);
                if (!this.options.ready()) break;
                await this.options.authorize(request);
                if (!this.options.ready()) break;
                claimed = journal.claim(profile, request.event, excluded);
                if (!claimed) continue;
                if (projection) journal.recordImageProjection(profile, request.event, projection);
                if (audioProjection)
                    journal.recordAudioProjection(profile, request.event, audioProjection);
                if (videoProjection)
                    journal.recordVideoProjection(profile, request.event, videoProjection);
                attempted = true;
                const ids = await invoke(async (ids) => {
                    journal.recordIds(profile, request.event, ids);
                });
                journal.sent(profile, request.event, ids);
                sent++;
            } catch {
                if (claimed) journal.unknown(profile, request.event);
                else journal.deferPreparation(profile, request.event);
                excluded.push(request.media.chat);
                failed = true;
            } finally {
                // After invocation, even a thrown send may already have changed the message model.
                if (prepared && !attempted) {
                    const pending = {chat: request.media.chat, discard: prepared.discard};
                    this.cleanup.set(request.id, pending);
                    try {
                        await pending.discard();
                        this.cleanup.delete(request.id);
                    } catch {
                        excluded.push(request.media.chat);
                        failed = true;
                    }
                }
            }
        }
        if (failed) throw new Error('Media work remains pending or uncertain');
        return sent;
    }
}
