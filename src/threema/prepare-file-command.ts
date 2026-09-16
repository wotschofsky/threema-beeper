import {MessagePort} from 'node:worker_threads';
import type {Readable} from 'node:stream';
import {receiveByteStream} from './byte-stream.ts';

export interface PrepareFileRequest {
    profile: string;
    chatId: string;
    bytes: number;
}
export function parsePrepareFile(value: unknown): PrepareFileRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid file preparation');
    const row = value as Record<string, unknown>;
    if (
        Object.keys(row).some((key) => !['profile', 'chatId', 'bytes'].includes(key)) ||
        typeof row.profile !== 'string' ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(row.profile) ||
        typeof row.chatId !== 'string' ||
        !/^(c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(row.chatId) ||
        !Number.isSafeInteger(row.bytes) ||
        (row.bytes as number) < 0 ||
        (row.bytes as number) > 1024 ** 3
    )
        throw new Error('Invalid file preparation');
    return {profile: row.profile, chatId: row.chatId, bytes: row.bytes as number};
}
export function parsePreparedToken(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw new Error('Invalid prepared file token');
    return value;
}
export async function prepareFileFromPort(
    session: {
        prepareFile(
            request: PrepareFileRequest,
            source: AsyncIterable<Uint8Array>,
        ): Promise<string>;
    },
    value: unknown,
): Promise<string> {
    const data = value as {request?: unknown; port?: unknown} | undefined;
    if (!(data?.port instanceof MessagePort)) throw new Error('Invalid preparation port');
    let source: Readable | undefined;
    try {
        const request = parsePrepareFile(data.request);
        source = receiveByteStream(data.port, {bytes: request.bytes});
        // Authorization may await before iteration; retain stream errors without an unhandled event.
        source.on('error', () => {});
        return parsePreparedToken(await session.prepareFile(request, source));
    } finally {
        source?.destroy();
        data.port.close();
    }
}

export interface DiscardPreparedFile {
    profile: string;
    chatId: string;
    token: string;
}
export function parseDiscardPreparedFile(value: unknown): DiscardPreparedFile {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid prepared file discard');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['profile', 'chatId', 'token'].includes(key)))
        throw new Error('Invalid prepared file discard');
    const {profile, chatId} = parsePrepareFile({
        profile: row.profile,
        chatId: row.chatId,
        bytes: 0,
    });
    return {profile, chatId, token: parsePreparedToken(row.token)};
}
