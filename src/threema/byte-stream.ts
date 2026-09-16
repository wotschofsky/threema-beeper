import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import type {MessagePort} from 'node:worker_threads';

const packetBytes = 64 * 1024;
interface Options {
    bytes: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}
function timeout(options: Options): number {
    const ms = options.timeoutMs ?? 30000;
    if (
        !Number.isSafeInteger(options.bytes) ||
        options.bytes < 0 ||
        options.bytes > 1024 ** 3 ||
        !Number.isSafeInteger(ms) ||
        ms < 1 ||
        ms > 300000
    )
        throw new Error('Invalid byte stream options');
    return ms;
}

/** Worker side: one demand credit permits at most one transferred 64 KiB packet. */
export function serveByteStream(
    port: MessagePort,
    source: Readable,
    options: Options,
): Promise<void> {
    const timeoutMs = timeout(options);
    async function nextChunk(): Promise<{done: boolean; value?: unknown}> {
        while (active) {
            const value: unknown = source.read(
                Math.min(packetBytes, source.readableLength || packetBytes),
            );
            if (value !== null) return {done: false, value};
            if (source.readableEnded) return {done: true};
            if (source.destroyed) throw new Error('Source closed');
            await new Promise<void>((ready) => {
                const wake = () => {
                    source.off('readable', wake);
                    source.off('end', wake);
                    source.off('close', wake);
                    ready();
                };
                source.once('readable', wake);
                source.once('end', wake);
                source.once('close', wake);
            });
        }
        return {done: true};
    }
    let active = true,
        busy = false,
        sequence = 0,
        sent = 0;
    let current: Uint8Array | undefined,
        offset = 0;
    let timer: NodeJS.Timeout;
    let resolve!: () => void;
    const done = new Promise<void>((complete) => {
        resolve = complete;
    });
    function finish(failed: boolean): void {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancelled);
        port.off('message', request);
        port.off('close', closed);
        port.off('messageerror', failedMessage);
        source.off('error', failedMessage);
        if (failed) {
            try {
                port.postMessage({type: 'error'});
            } catch {
                /* Peer already closed. */
            }
        }
        source.destroy();
        port.close();
        void finished(source, {cleanup: true})
            .catch(() => undefined)
            .then(resolve);
    }
    function arm(): void {
        clearTimeout(timer);
        timer = setTimeout(() => finish(true), timeoutMs);
    }
    function cancelled(): void {
        finish(true);
    }
    function closed(): void {
        finish(false);
    }
    function failedMessage(): void {
        finish(true);
    }
    async function request(packet: unknown): Promise<void> {
        if (!active) return;
        if (!packet || typeof packet !== 'object') {
            finish(true);
            return;
        }
        const data = packet as {type?: unknown; sequence?: unknown};
        if (data.type === 'cancel') {
            finish(false);
            return;
        }
        if (data.type !== 'pull' || data.sequence !== sequence || busy) {
            finish(true);
            return;
        }
        busy = true;
        arm();
        try {
            if (!current || offset === current.byteLength) {
                const next = await nextChunk();
                if (!active) return;
                if (next.done) {
                    if (sent !== options.bytes) throw new Error('Stream length mismatch');
                    port.postMessage({type: 'end', sequence});
                    finish(false);
                    return;
                }
                if (
                    !(next.value instanceof Uint8Array) ||
                    next.value.byteLength === 0 ||
                    next.value.byteLength > 1024 * 1024
                )
                    throw new Error('Invalid source chunk');
                current = next.value;
                offset = 0;
            }
            const size = Math.min(packetBytes, current.byteLength - offset);
            if (sent + size > options.bytes) throw new Error('Stream length exceeded');
            const bytes = new Uint8Array(size);
            bytes.set(current.subarray(offset, offset + size));
            offset += size;
            sent += size;
            port.postMessage({type: 'data', sequence: sequence++, bytes}, [bytes.buffer]);
            busy = false;
            arm();
        } catch {
            finish(true);
        }
    }
    port.on('message', request);
    port.once('close', closed);
    port.once('messageerror', failedMessage);
    source.once('error', failedMessage);
    options.signal?.addEventListener('abort', cancelled, {once: true});
    arm();
    if (options.signal?.aborted) finish(true);
    return done;
}

/** Parent side: Node demand drives the worker; no model, file path or key is part of this protocol. */
export function receiveByteStream(port: MessagePort, options: Options): Readable {
    const timeoutMs = timeout(options);
    let sequence = 0,
        received = 0,
        pending = false,
        ended = false;
    let timer: NodeJS.Timeout | undefined;
    const stream = new Readable({
        highWaterMark: packetBytes,
        read() {
            if (pending || ended) return;
            pending = true;
            timer = setTimeout(
                () => stream.destroy(new Error('Media stream timed out')),
                timeoutMs,
            );
            port.postMessage({type: 'pull', sequence});
        },
        destroy(error, callback) {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
            port.off('message', message);
            port.off('close', close);
            port.off('messageerror', invalid);
            try {
                port.postMessage({type: 'cancel'});
            } catch {
                /* Peer already closed. */
            }
            port.close();
            callback(error);
        },
    });
    function invalid(): void {
        stream.destroy(new Error('Invalid media stream response'));
    }
    function abort(): void {
        stream.destroy(new Error('Media stream cancelled'));
    }
    function close(): void {
        if (!ended) stream.destroy(new Error('Media stream closed early'));
    }
    function message(packet: unknown): void {
        if (!pending || !packet || typeof packet !== 'object') {
            invalid();
            return;
        }
        const value = packet as {type?: unknown; sequence?: unknown; bytes?: unknown};
        if (value.sequence !== sequence || (value.type !== 'data' && value.type !== 'end')) {
            invalid();
            return;
        }
        clearTimeout(timer);
        pending = false;
        if (value.type === 'end') {
            if (received !== options.bytes) {
                invalid();
                return;
            }
            ended = true;
            stream.push(null);
            return;
        }
        if (
            !(value.bytes instanceof Uint8Array) ||
            !(value.bytes.buffer instanceof ArrayBuffer) ||
            value.bytes.byteLength < 1 ||
            value.bytes.byteLength > packetBytes ||
            received + value.bytes.byteLength > options.bytes
        ) {
            invalid();
            return;
        }
        received += value.bytes.byteLength;
        sequence++;
        stream.push(Buffer.from(value.bytes));
    }
    port.on('message', message);
    port.once('close', close);
    port.once('messageerror', invalid);
    options.signal?.addEventListener('abort', abort, {once: true});
    if (options.signal?.aborted) queueMicrotask(abort);
    return stream;
}
