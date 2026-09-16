import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import {createServer, type IncomingMessage} from 'node:http';
import type {LinkSession} from './link-session.ts';

const qr: {
    toBuffer(text: string, options: {type: 'png'; width: number; margin: number}): Promise<Buffer>;
} = createRequire(import.meta.url)(
    '../../.local/sources/threema-desktop/apps/desktop/node_modules/qrcode',
);

type Session = Pick<
    LinkSession,
    'state' | 'begin' | 'cancel' | 'stop' | 'finish' | 'recoverySecret'
>;
class HttpError extends Error {
    readonly status: number;
    constructor(status: number) {
        super('Setup request rejected');
        this.status = status;
    }
}
function sameSecret(first: string, second: string): boolean {
    return timingSafeEqual(
        createHash('sha256').update(first).digest(),
        createHash('sha256').update(second).digest(),
    );
}
async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
        throw new HttpError(415);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request.iterator({destroyOnReturn: false})) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 4096) throw new HttpError(413);
        chunks.push(bytes);
    }
    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('Expected object');
        return parsed as Record<string, unknown>;
    } catch {
        throw new HttpError(400);
    }
}

/** API for the local pairing UI. This function always binds IPv4 loopback. */
export async function startSetupServer(
    session: Session,
    options: {port?: number; inactivityMs?: number} = {},
): Promise<{
    url: string;
    terminalStateDelivered: Promise<void>;
    close: () => Promise<void>;
}> {
    const ttl = options.inactivityMs ?? 15 * 60 * 1000;
    if (!Number.isSafeInteger(ttl) || ttl < 10 || ttl > 15 * 60 * 1000)
        throw new Error('Invalid setup expiry');
    let terminalDelivered!: () => void;
    const terminalStateDelivered = new Promise<void>((resolve) => {
        terminalDelivered = resolve;
    });
    let token: string | undefined = randomBytes(32).toString('base64url');
    let cookie: string | undefined;
    let expires = performance.now() + ttl;
    let expired = false;
    let finished = false;
    let closing: Promise<void> | undefined;
    let origin = '';
    const server = createServer((request, response) => {
        const reply = (status: number, value: unknown = {}): void => {
            response.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            });
            response.end(JSON.stringify(value));
        };
        void (async () => {
            if (expired || performance.now() >= expires) throw new HttpError(410);
            if (request.headers.host !== new URL(origin).host) throw new HttpError(403);
            const url = new URL(request.url ?? '/', origin);
            if (request.method === 'POST' && request.headers.origin !== origin)
                throw new HttpError(403);
            if (request.headers.origin && request.headers.origin !== origin)
                throw new HttpError(403);
            if (
                request.headers['sec-fetch-site'] &&
                request.headers['sec-fetch-site'] !== 'same-origin' &&
                request.headers['sec-fetch-site'] !== 'none'
            )
                throw new HttpError(403);
            const assets: Record<string, {path: URL; type: string}> = {
                '/': {
                    path: new URL('./web/index.html', import.meta.url),
                    type: 'text/html; charset=utf-8',
                },
                '/setup.css': {path: new URL('./web/setup.css', import.meta.url), type: 'text/css'},
                '/setup.js': {
                    path: new URL('../../.local/setup-ui/setup.js', import.meta.url),
                    type: 'text/javascript',
                },
            };
            const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
            if (request.method === 'GET' && asset) {
                const content = readFileSync(asset.path);
                response.writeHead(200, {
                    'Content-Type': asset.type,
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                    'X-Content-Type-Options': 'nosniff',
                    'Content-Security-Policy':
                        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
                });
                response.end(content);
                return;
            }
            if (url.pathname === '/session' && request.method === 'POST') {
                const body = await readObject(request);
                if (!token || typeof body.token !== 'string' || !sameSecret(token, body.token))
                    throw new HttpError(401);
                token = undefined;
                cookie = randomBytes(32).toString('base64url');
                expires = performance.now() + ttl;
                response.setHeader(
                    'Set-Cookie',
                    `setup_session=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
                );
                reply(200);
                return;
            }
            const supplied = /(?:^|;\s*)setup_session=([A-Za-z0-9_-]+)(?:;|$)/.exec(
                request.headers.cookie ?? '',
            )?.[1];
            if (!cookie || !supplied || !sameSecret(cookie, supplied)) throw new HttpError(401);
            // Background state/QR polling must not keep an unattended setup alive.
            if (request.method === 'POST' || url.pathname === '/recovery')
                expires = performance.now() + ttl;
            if (url.pathname === '/qr' && request.method === 'GET') {
                const state = session.state;
                if (state.state !== 'qr') throw new HttpError(409);
                const png = await qr.toBuffer(state.uri, {type: 'png', width: 320, margin: 4});
                response.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                });
                response.end(png);
                return;
            }
            if (url.pathname === '/state' && request.method === 'GET') {
                const state = session.state;
                if (['error', 'interrupted', 'cancelled', 'finished'].includes(state.state))
                    response.once('finish', terminalDelivered);
                reply(200, state);
                return;
            }
            if (url.pathname === '/recovery' && request.method === 'GET') {
                reply(200, {secret: session.recoverySecret()});
                return;
            }
            if (request.method !== 'POST') throw new HttpError(404);
            const body = await readObject(request);
            switch (url.pathname) {
                case '/begin':
                    if (session.state.state !== 'idle') throw new HttpError(409);
                    void session.begin().catch(() => undefined);
                    reply(202);
                    break;
                case '/cancel':
                    await session.cancel();
                    reply(200);
                    break;
                case '/finish':
                    session.finish(body.recoverySaved === true);
                    finished = true;
                    token = undefined;
                    cookie = undefined;
                    reply(200);
                    // Keep the linked backend alive for the bridge, but close the setup listener.
                    void close().catch(() => undefined);
                    break;
                default:
                    throw new HttpError(404);
            }
        })().catch((error) => {
            request.resume();
            reply(error instanceof HttpError ? error.status : 409);
        });
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    const timer = setInterval(
        () => {
            if (performance.now() >= expires) {
                expired = true;
                void close().catch(() => undefined);
            }
        },
        Math.min(ttl, 1000),
    );
    timer.unref();
    async function close(): Promise<void> {
        if (!closing) {
            expired = true;
            token = undefined;
            cookie = undefined;
            clearInterval(timer);
            terminalDelivered();
            closing = (async () => {
                const listenerClosed = new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    server.closeIdleConnections();
                    if (!finished) server.closeAllConnections();
                });
                if (!finished) {
                    try {
                        await session.cancel();
                    } catch {
                        await session.stop();
                    }
                }
                await listenerClosed;
            })();
        }
        await closing;
    }
    try {
        server.listen(options.port ?? 0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Setup listener unavailable');
        origin = `http://127.0.0.1:${address.port}`;
        return {url: `${origin}/#setup=${token}`, terminalStateDelivered, close};
    } catch (error) {
        clearInterval(timer);
        server.close();
        throw error;
    }
}
