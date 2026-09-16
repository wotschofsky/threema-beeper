import {createHash} from 'node:crypto';
import type {Readable} from 'node:stream';
import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {NormalizedNodeMessage} from '../threema/history.ts';
import {decodeMessage, encodeMessage} from '../threema/message-codec.ts';
import type {MediaTransfer} from './media-transfer.ts';

export interface MediaDescriptor {
    bytes: number;
    sha256: string;
    mimeType: string;
    open(): Promise<Readable>;
}
interface Options {
    profile: string;
    transfer: MediaTransfer;
    client: Pick<MatrixClient, 'doRequest'>;
    describe: (
        message: NormalizedNodeMessage,
        part: 'file' | 'thumbnail',
    ) => Promise<MediaDescriptor>;
    maxBytes: () => Promise<number>;
    verifyMime: (header: Buffer, declared: string) => Promise<void>;
    signal?: AbortSignal;
}

/** Uploads both encrypted payloads before returning event content. No plaintext media URLs. */
export class MediaRenderer {
    private readonly options: Options;
    constructor(options: Options) {
        this.options = options;
    }
    async render(value: NormalizedNodeMessage): Promise<Record<string, unknown>> {
        const message = decodeMessage(encodeMessage(value));
        const media = message.content;
        if (
            media.type !== 'image' &&
            media.type !== 'video' &&
            media.type !== 'audio' &&
            media.type !== 'file'
        )
            throw new Error('Not a media message');
        const limit = await this.options.maxBytes();
        if (!Number.isSafeInteger(limit) || limit < 1 || media.byteSize > limit)
            throw new Error('MEDIA_TOO_LARGE');
        const main = await this.options.describe(message, 'file');
        if (main.bytes !== media.byteSize || main.mimeType !== media.mimeType)
            throw new Error('Media descriptor does not match canonical metadata');
        const upload = async (part: string, descriptor: MediaDescriptor) => {
            const id =
                'media_' +
                createHash('sha256')
                    .update(
                        JSON.stringify([
                            this.options.profile,
                            message.chatId,
                            message.messageId,
                            part,
                            descriptor.sha256,
                            descriptor.mimeType,
                        ]),
                    )
                    .digest('hex');
            return this.options.transfer.transfer(
                id,
                this.options.profile,
                this.options.client,
                () => descriptor.open(),
                {
                    ...descriptor,
                    maxBytes: limit,
                    verifyMime: this.options.verifyMime,
                    signal: this.options.signal,
                },
            );
        };
        const file = await upload('file', main);
        const info: Record<string, unknown> = {mimetype: media.mimeType, size: media.byteSize};
        if (media.dimensions) {
            info.w = media.dimensions.width;
            info.h = media.dimensions.height;
        }
        if (media.durationSeconds !== undefined) {
            const duration = Math.round(media.durationSeconds * 1000);
            if (!Number.isSafeInteger(duration) || duration < 0)
                throw new Error('Invalid Matrix media duration');
            info.duration = duration;
        }
        if (media.thumbnailRef) {
            const thumbnail = await this.options.describe(message, 'thumbnail');
            if (media.thumbnailMimeType && thumbnail.mimeType !== media.thumbnailMimeType)
                throw new Error('Thumbnail MIME does not match canonical metadata');
            info.thumbnail_file = await upload('thumbnail', thumbnail);
            info.thumbnail_info = {mimetype: thumbnail.mimeType, size: thumbnail.bytes};
        }
        const filename = media.fileName || `Threema ${media.type}`;
        return {msgtype: `m.${media.type}`, body: media.caption || filename, filename, file, info};
    }
}
