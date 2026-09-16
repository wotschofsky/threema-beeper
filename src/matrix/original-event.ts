import {
    EncryptedRoomEvent,
    type MatrixClient,
} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {getRequestFn} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';
import {Agent} from '../../.local/sources/matrix-appservice-bridge/node_modules/undici/index.js';
import type {Readable} from 'node:stream';
import type {InboxEvent} from './transaction-inbox.ts';

/** Fetch only the requested encrypted owner event, then decrypt with the already-open native client. */
export function createOriginalEventLoader(options: {
    client: Pick<MatrixClient, 'homeserverUrl' | 'accessToken' | 'crypto'>;
    userId: string;
    owner: string;
    authorize: (room: string) => Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
    maximumBytes?: number;
}) {
    const timeoutMs = options.timeoutMs ?? 30000,
        maximumBytes = options.maximumBytes ?? 2 * 1024 * 1024;
    if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 60000 ||
        !Number.isInteger(maximumBytes) ||
        maximumBytes < 1 ||
        maximumBytes > 8 * 1024 * 1024
    )
        throw new Error('Invalid original event limits');
    return async (event: string, room: string): Promise<InboxEvent | undefined> => {
        if (
            !/^\$[^\s]{1,1024}$/.test(event) ||
            !/^![^\s]{1,1024}:[^\s]+$/.test(room) ||
            !/^@[^\s]+:[^\s]+$/.test(options.userId) ||
            !/^@[^\s]+:[^\s]+$/.test(options.owner)
        )
            throw new Error('Invalid original event target');
        const base = new URL(options.client.homeserverUrl);
        const token = options.client.accessToken;
        if (
            base.username ||
            base.password ||
            base.search ||
            base.hash ||
            (base.protocol !== 'https:' &&
                !(
                    base.protocol === 'http:' &&
                    ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
                )) ||
            typeof token !== 'string' ||
            !token ||
            /[\r\n]/.test(token)
        )
            throw new Error('Invalid original event transport');
        const deadline = new AbortController(),
            signal = options.signal
                ? AbortSignal.any([options.signal, deadline.signal])
                : deadline.signal;
        const timer = setTimeout(() => deadline.abort(), timeoutMs);
        const dispatcher = new Agent({connections: 1});
        let stream: Readable | undefined;
        const bounded = async <T>(action: () => Promise<T>): Promise<T> => {
            signal.throwIfAborted();
            let abort!: () => void;
            const interrupted = new Promise<never>((_, reject) => {
                abort = () => reject(new Error('Original event retrieval interrupted'));
            });
            signal.addEventListener('abort', abort, {once: true});
            try {
                return await Promise.race([action(), interrupted]);
            } finally {
                signal.removeEventListener('abort', abort);
            }
        };
        try {
            await bounded(() => options.authorize(room));
            signal.throwIfAborted();
            if (!options.client.crypto.isReady)
                throw new Error('Original event crypto unavailable');
            const url = new URL(
                options.client.homeserverUrl.replace(/\/$/, '') +
                    '/_matrix/client/v3/rooms/' +
                    encodeURIComponent(room) +
                    '/event/' +
                    encodeURIComponent(event),
            );
            url.searchParams.set('user_id', options.userId);
            // The SDK transport uses bounded streaming, rather than eager getEvent buffering.
            const response = await bounded(() =>
                Promise.resolve(
                    getRequestFn()(url, {
                        method: 'GET',
                        headers: {Authorization: `Bearer ${token}`},
                        signal,
                        dispatcher,
                        headersTimeout: timeoutMs,
                        bodyTimeout: timeoutMs,
                    }),
                ).then(
                    (response: {
                        statusCode: number;
                        headers: Record<string, unknown>;
                        body: Readable;
                    }) => {
                        if (signal.aborted) {
                            response.body.destroy();
                            throw new Error('Original response arrived after cancellation');
                        }
                        return response;
                    },
                ),
            );
            stream = response.body;
            if (response.statusCode === 404) return undefined;
            if (
                response.statusCode !== 200 ||
                (response.headers['content-encoding'] !== undefined &&
                    response.headers['content-encoding'] !== 'identity')
            )
                throw new Error('Original event download failed');
            const chunks: Buffer[] = [];
            let bytes = 0;
            await bounded(async () => {
                for await (const chunk of stream!) {
                    const data = Buffer.from(chunk);
                    bytes += data.length;
                    if (bytes > maximumBytes) throw new Error('Original event exceeds limit');
                    chunks.push(data);
                }
            });
            const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const matches = (value: any) =>
                value &&
                typeof value === 'object' &&
                !Array.isArray(value) &&
                value.event_id === event &&
                value.room_id === room &&
                value.sender === options.owner &&
                value.state_key === undefined &&
                value.content &&
                typeof value.content === 'object' &&
                !Array.isArray(value.content);
            if (!matches(raw) || raw.type !== 'm.room.encrypted')
                throw new Error('Original event identity or encryption mismatch');
            signal.throwIfAborted();
            const decrypted = await bounded(() =>
                options.client.crypto.decryptRoomEvent(new EncryptedRoomEvent(raw), room),
            );
            const clear = decrypted.raw;
            if (
                !matches(clear) ||
                clear.type !== 'm.room.message' ||
                Buffer.byteLength(JSON.stringify(clear)) > maximumBytes
            )
                throw new Error('Original event plaintext mismatch');
            await bounded(() => options.authorize(room));
            signal.throwIfAborted();
            if (!options.client.crypto.isReady) throw new Error('Original event crypto closed');
            return {
                event_id: event,
                room_id: room,
                sender: options.owner,
                type: 'm.room.message',
                encrypted: true,
                content: structuredClone(clear.content),
            };
        } catch {
            throw new Error('Original encrypted event could not be retrieved or verified');
        } finally {
            clearTimeout(timer);
            stream?.destroy();
            await dispatcher.destroy();
        }
    };
}
