import {renderMetrics, type MetricsSnapshot} from '../service/metrics.ts';
import {createHash, timingSafeEqual} from 'node:crypto';
import {createServer, type IncomingMessage, type Server} from 'node:http';
import {TransactionConflictError, TransactionInbox} from './transaction-inbox.ts';

class RequestError extends Error {
    readonly status: number;
    constructor(status: number) {
        super('Invalid appservice request');
        this.status = status;
    }
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Bound JSON complexity before canonicalization, storage, or SDK processing. */
export function validateTransaction(
    value: unknown,
): asserts value is Record<string, unknown> & {events: unknown[]} {
    let nodes = 0;
    const visit = (item: unknown, depth: number): void => {
        if (++nodes > 100000 || depth > 32) throw new RequestError(400);
        if (item !== null && typeof item === 'object') {
            for (const child of Object.values(item)) visit(child, depth + 1);
        }
    };
    visit(value, 0);
    if (!record(value) || !Array.isArray(value.events) || value.events.length > 10000)
        throw new RequestError(400);
    for (const event of value.events) {
        if (!record(event) || !record(event.content)) throw new RequestError(400);
        for (const key of ['event_id', 'room_id', 'sender', 'type']) {
            if (
                typeof event[key] !== 'string' ||
                event[key].length === 0 ||
                event[key].length > 1024
            )
                throw new RequestError(400);
        }
        if (event.state_key !== undefined && typeof event.state_key !== 'string')
            throw new RequestError(400);
        if (
            event.origin_server_ts !== undefined &&
            (!Number.isSafeInteger(event.origin_server_ts) ||
                (event.origin_server_ts as number) < 0)
        )
            throw new RequestError(400);
    }
}

async function bodyOf(request: IncomingMessage, maxBytes: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request.iterator({destroyOnReturn: false})) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) throw new RequestError(413);
        chunks.push(buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new RequestError(400);
    }
}

/**
 * Creates an unbound server. Bind only to loopback behind bbctl proxy.
 * A 200 response means durable acceptance, not completed delivery to Threema.
 */
export function createTransactionServer(
    inbox: TransactionInbox,
    homeserverToken: string,
    maxBytes = 1024 * 1024,
    health?: () => {live: boolean; ready: boolean},
    metrics?: () => MetricsSnapshot,
    onFreshTransaction?: (body: Record<string, unknown>) => void,
    bridgeStatus?: () => unknown,
    recovery?: (action: 'status' | 'resync' | 'retry') => unknown,
): Server {
    if (homeserverToken.length < 16) throw new Error('Homeserver token is too short');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
        throw new Error('Invalid request size limit');
    const tokenHash = createHash('sha256').update(homeserverToken).digest();
    const server = createServer((request, response) => {
        const reply = (status: number): void => {
            if (response.destroyed) return;
            response.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            });
            response.end(
                status === 200
                    ? '{}'
                    : JSON.stringify({errcode: status === 401 ? 'M_UNAUTHORIZED' : 'M_UNKNOWN'}),
            );
        };
        void (async () => {
            const healthPath = request.url?.split('?')[0];
            if (
                health &&
                (request.method === 'GET' || request.method === 'HEAD') &&
                (healthPath === '/livez' || healthPath === '/readyz')
            ) {
                let ok = false;
                try {
                    const status = health();
                    ok = healthPath === '/livez' ? status.live === true : status.ready === true;
                } catch {
                    /* A failed health probe reports unavailable without exposing diagnostics. */
                }
                request.resume();
                response.writeHead(ok ? 200 : 503, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                });
                response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ok}));
                return;
            }
            if (
                metrics &&
                healthPath === '/metrics' &&
                (request.method === 'GET' || request.method === 'HEAD')
            ) {
                request.resume();
                let body: string;
                try {
                    body = renderMetrics(metrics());
                } catch {
                    reply(503);
                    return;
                }
                response.writeHead(200, {
                    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
                    'Cache-Control': 'no-store',
                });
                response.end(request.method === 'HEAD' ? undefined : body);
                return;
            }
            const authorization = request.headers.authorization ?? '';
            if (
                !authorization.startsWith('Bearer ') ||
                !timingSafeEqual(
                    tokenHash,
                    createHash('sha256').update(authorization.slice(7)).digest(),
                )
            ) {
                request.resume();
                reply(401);
                return;
            }
            if (
                bridgeStatus &&
                healthPath === '/_threema/bridge-state' &&
                request.method === 'GET'
            ) {
                request.resume();
                const body = JSON.stringify(bridgeStatus());
                response.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                });
                response.end(body);
                return;
            }
            if (recovery && healthPath === '/_threema/recovery') {
                let action: 'status' | 'resync' | 'retry' = 'status';
                if (request.method === 'POST') {
                    const body = await bodyOf(request, 1024);
                    if (
                        !record(body) ||
                        Object.keys(body).join() !== 'action' ||
                        typeof body.action !== 'string' ||
                        !['resync', 'retry'].includes(body.action)
                    )
                        throw new RequestError(400);
                    action = body.action as 'resync' | 'retry';
                } else if (request.method !== 'GET') {
                    request.resume();
                    reply(405);
                    return;
                } else request.resume();
                const result = recovery(action);
                response.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                });
                response.end(JSON.stringify(result));
                return;
            }
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            const match = /^\/(?:_matrix\/app\/v1\/)?transactions\/([^/]+)$/.exec(url.pathname);
            if (request.method !== 'PUT' || !match) {
                request.resume();
                reply(404);
                return;
            }
            if (
                request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !==
                'application/json'
            )
                throw new RequestError(415);
            if (Number(request.headers['content-length'] ?? 0) > maxBytes)
                throw new RequestError(413);
            let id: string;
            try {
                id = decodeURIComponent(match[1]!);
            } catch {
                throw new RequestError(400);
            }
            if (!id || id.length > 255) throw new RequestError(400);
            const body = await bodyOf(request, maxBytes);
            validateTransaction(body);
            const accepted = inbox.accept(id, body);
            if (accepted === 'accepted') {
                try {
                    onFreshTransaction?.(body);
                } catch {
                    // Transient events may be dropped; durable acceptance must remain successful.
                }
            }
            reply(200);
        })().catch((error) => {
            // Never return or log tokens, request contents, SQL errors, or SDK exception details.
            request.resume();
            reply(
                error instanceof RequestError
                    ? error.status
                    : error instanceof TransactionConflictError
                      ? 409
                      : 503,
            );
        });
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    return server;
}
