import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import {getRequestFn} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';
import {Readable} from 'node:stream';
import {Agent} from '../../.local/sources/matrix-appservice-bridge/node_modules/undici/index.js';
import {prepareOutboundAttachment, type OutboundAttachmentInput} from './outbound-attachment.ts';

/** SDK transport, streamed instead of MatrixClient.downloadContent's eager response buffering. */
export async function downloadAttachment(
    client: Pick<
        MatrixClient,
        'homeserverUrl' | 'accessToken' | 'doesServerSupportVersion' | 'contentScannerInstance'
    >,
    userId: string,
    mxc: string,
    directory: string,
    input: OutboundAttachmentInput,
    timeoutMs = 60000,
) {
    input = {...input, file: structuredClone(input.file)};
    const homeserver = client.homeserverUrl,
        token = client.accessToken;
    if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 300000 ||
        !/^@[^\s]+:[^\s]+$/.test(userId) ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1 ||
        input.maxBytes > 1024 ** 3 ||
        (input.bytes !== undefined &&
            (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > input.maxBytes))
    )
        throw new Error('Invalid attachment download');
    const match = /^mxc:\/\/([^\s/?#@]+)\/([A-Za-z0-9._~-]{1,255})$/.exec(mxc);
    if (!match || mxc.length > 2048) throw new Error('Invalid attachment location');
    const base = new URL(homeserver);
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
        typeof client.accessToken !== 'string' ||
        !client.accessToken ||
        /[\r\n]/.test(client.accessToken) ||
        client.contentScannerInstance
    )
        throw new Error('Unsupported attachment transport configuration');
    const dispatcher = new Agent({connections: 1});
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = input.signal
        ? AbortSignal.any([input.signal, deadline.signal])
        : deadline.signal;
    let source: Readable | undefined;
    try {
        signal.throwIfAborted();
        // Discovery is SDK-managed. Bound our wait even when its underlying request outlives cancellation.
        const modern = await new Promise<boolean>((resolve, reject) => {
            const abort = () => reject(new Error('Attachment download cancelled'));
            signal.addEventListener('abort', abort, {once: true});
            client
                .doesServerSupportVersion('v1.11')
                .then(resolve, reject)
                .finally(() => signal.removeEventListener('abort', abort));
        });
        signal.throwIfAborted();
        const prefix = modern ? '/_matrix/client/v1/media' : '/_matrix/media/v3';
        const url = new URL(
            homeserver.replace(/\/$/, '') +
                prefix +
                '/download/' +
                encodeURIComponent(match[1]!) +
                '/' +
                encodeURIComponent(match[2]!),
        );
        url.searchParams.set('user_id', userId);
        url.searchParams.set('allow_remote', 'true');
        let response = await getRequestFn()(url, {
            method: 'GET',
            headers: {Authorization: `Bearer ${token}`},
            signal,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            dispatcher,
        });
        source = response.body;
        // Rejected response bodies can emit an asynchronous abort error during destroy.
        // Attach before checking status/headers; pipeline still propagates stream failures.
        source.on('error', () => {});
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            const location = response.headers.location;
            if (typeof location !== 'string') throw new Error('Invalid media redirect');
            const target = new URL(location, url);
            // Hungryserv serves encrypted objects from signed R2 URLs. Never forward
            // Matrix credentials, follow another redirect, or accept arbitrary hosts.
            if (
                base.origin !== 'https://matrix.beeper.com' ||
                !base.pathname.startsWith('/_hungryserv/') ||
                target.protocol !== 'https:' ||
                target.username ||
                target.password ||
                target.port ||
                target.hash ||
                !/^prod-hungryserv-media-[a-z0-9-]+\.[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/.test(
                    target.hostname,
                )
            )
                throw new Error('Unsupported media redirect');
            source.destroy();
            response = await getRequestFn()(target, {
                method: 'GET',
                signal,
                headersTimeout: timeoutMs,
                bodyTimeout: timeoutMs,
                dispatcher,
            });
            source = response.body;
            source.on('error', () => {});
        }
        if (response.statusCode !== 200) throw new Error('Attachment download failed');
        const length = response.headers['content-length'];
        if (
            length !== undefined &&
            (typeof length !== 'string' ||
                !/^\d+$/.test(length) ||
                !Number.isSafeInteger(Number(length)) ||
                Number(length) > input.maxBytes ||
                (input.bytes !== undefined && Number(length) !== input.bytes))
        )
            throw new Error('Invalid attachment download size');
        const encoding = response.headers['content-encoding'];
        if (encoding !== undefined && encoding !== 'identity')
            throw new Error('Unsupported attachment content encoding');
        // The deadline applies to preparation. Returned readers use the caller's lifetime signal.
        const prepared = await prepareOutboundAttachment(source, directory, {...input, signal});
        return prepared;
    } catch {
        throw new Error('Attachment download or verification failed');
    } finally {
        clearTimeout(timer);
        source?.destroy();
        await dispatcher.destroy();
    }
}
