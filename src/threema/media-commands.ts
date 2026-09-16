import type {Readable} from 'node:stream';
import type {MessagePort} from 'node:worker_threads';
import {serveByteStream} from './byte-stream.ts';
import {parseHistoryRequest} from './history.ts';

export interface MediaRequest {
    chatId: string;
    messageId: string;
    part: 'file' | 'thumbnail';
    maximumBytes: number;
}
export interface MediaInfo {
    bytes: number;
    sha256: string;
    mimeType: string;
}
export function parseMediaRequest(value: unknown): MediaRequest {
    const row = value as Partial<MediaRequest> | null;
    if (
        !row ||
        !/^m:[0-9a-f]{16}$/.test(row.messageId ?? '') ||
        (row.part !== 'file' && row.part !== 'thumbnail') ||
        !Number.isSafeInteger(row.maximumBytes) ||
        row.maximumBytes! < 0 ||
        row.maximumBytes! > 1024 ** 3
    )
        throw new Error('Invalid media request');
    const chatId = parseHistoryRequest({chatId: row.chatId, limit: 1}).chatId;
    return {chatId, messageId: row.messageId!, part: row.part, maximumBytes: row.maximumBytes!};
}
export function parseMediaInfo(value: unknown, maximumBytes: number): MediaInfo {
    const row = value as Partial<MediaInfo> | null;
    if (
        !row ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes! < 0 ||
        row.bytes! > maximumBytes ||
        typeof row.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.sha256) ||
        typeof row.mimeType !== 'string' ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(row.mimeType)
    )
        throw new Error('Invalid media descriptor');
    return {bytes: row.bytes!, sha256: row.sha256, mimeType: row.mimeType};
}
type Resolve = (
    request: MediaRequest,
    signal?: AbortSignal,
) => Promise<MediaInfo & {open(signal?: AbortSignal): Readable}>;

/** Caps hashing and streaming together; local handles live only inside the resolver. */
export class MediaCommands {
    private active = 0;
    private readonly resolve: Resolve;
    constructor(resolve: Resolve) {
        this.resolve = resolve;
    }
    private acquire(): () => void {
        if (this.active >= 4) throw new Error('Too many media operations');
        this.active++;
        return () => {
            this.active--;
        };
    }
    async info(value: unknown): Promise<MediaInfo> {
        const request = parseMediaRequest(value),
            release = this.acquire();
        try {
            return parseMediaInfo(await this.resolve(request), request.maximumBytes);
        } finally {
            release();
        }
    }
    async stream(value: unknown, expectedValue: unknown, port: MessagePort): Promise<MediaInfo> {
        const abort = new AbortController();
        const close = () => abort.abort();
        port.once('close', close);
        let release: (() => void) | undefined;
        try {
            const request = parseMediaRequest(value),
                expected = parseMediaInfo(expectedValue, request.maximumBytes);
            release = this.acquire();
            const source = await this.resolve(request, abort.signal);
            abort.signal.throwIfAborted();
            const info = parseMediaInfo(source, request.maximumBytes);
            if (
                info.bytes !== expected.bytes ||
                info.sha256 !== expected.sha256 ||
                info.mimeType !== expected.mimeType
            )
                throw new Error('Media changed before streaming');
            const finished = serveByteStream(port, source.open(abort.signal), {
                bytes: info.bytes,
                signal: abort.signal,
            });
            const unlock = release;
            release = undefined;
            void finished
                .finally(() => {
                    port.off('close', close);
                    unlock();
                })
                .catch(() => port.close());
            return info;
        } catch (error) {
            port.off('close', close);
            port.close();
            abort.abort();
            release?.();
            throw error;
        }
    }
}
