import {MessagePort} from 'node:worker_threads';
import {parseHistoryPage, type NormalizedNodeMessage} from './history.ts';

/** One in-flight message per port. The sender waits for durable consumer acknowledgement. */
export async function serveMessages(
    port: MessagePort,
    chatId: string,
    attach: (
        consume: (message: NormalizedNodeMessage) => Promise<void>,
        reset: () => void,
    ) => Promise<() => Promise<void>>,
    timeoutMs = 30000,
): Promise<void> {
    let active = true;
    let next = 0;
    let unsubscribe: (() => Promise<void>) | undefined;
    let pending:
        | {id: number; resolve: () => void; reject: () => void; timer: NodeJS.Timeout}
        | undefined;
    function finish(reset: boolean): void {
        if (!active) return;
        active = false;
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject();
            pending = undefined;
        }
        if (reset) port.postMessage({type: 'reset'});
        void Promise.resolve()
            .then(() => unsubscribe?.())
            .finally(() => {
                port.postMessage({type: 'closed'});
                port.close();
            })
            .catch(() => undefined);
    }
    port.on('message', (packet: unknown) => {
        if (!packet || typeof packet !== 'object') {
            finish(true);
            return;
        }
        const message = packet as {type?: unknown; id?: unknown};
        if (message.type === 'stop') {
            finish(false);
            return;
        }
        if (message.type !== 'ack' || !pending || message.id !== pending.id) {
            finish(true);
            return;
        }
        clearTimeout(pending.timer);
        const current = pending;
        pending = undefined;
        current.resolve();
    });
    port.on('close', () => finish(true));
    try {
        unsubscribe = await attach(
            async (message) => {
                if (!active || pending) throw new Error('Subscription is not writable');
                const safe = parseHistoryPage({messages: [message]}, {chatId, limit: 1})
                    .messages[0]!;
                await new Promise<void>((resolve, reject) => {
                    const id = ++next;
                    pending = {
                        id,
                        resolve,
                        reject: () => reject(new Error('Subscription interrupted')),
                        timer: setTimeout(() => finish(true), timeoutMs),
                    };
                    pending.timer.unref();
                    port.postMessage({type: 'message', id, value: safe});
                });
            },
            () => finish(true),
        );
        if (!active) await unsubscribe();
    } catch (error) {
        finish(true);
        throw error;
    }
}

export function receiveMessages(
    port: MessagePort,
    chatId: string,
    consume: (message: NormalizedNodeMessage) => Promise<void>,
    onReset: () => void,
): {stop: () => Promise<void>; dispose: () => void} {
    let active = true;
    let expected = 1;
    let processing: Promise<void> | undefined;
    let closeResolve!: () => void;
    const closed = new Promise<void>((resolve) => {
        closeResolve = resolve;
    });
    function reset(): void {
        if (!active) return;
        active = false;
        try {
            onReset();
        } catch {
            /* User callbacks cannot strand the port. */
        }
        port.postMessage({type: 'stop'});
    }
    port.on('close', () => {
        reset();
        closeResolve();
    });
    port.on('message', (packet: unknown) => {
        if (!packet || typeof packet !== 'object') {
            reset();
            return;
        }
        const message = packet as {type?: unknown; id?: unknown; value?: unknown};
        if (message.type === 'closed') {
            reset();
            port.close();
            return;
        }
        if (message.type === 'reset') {
            reset();
            return;
        }
        if (!active) return;
        if (message.type !== 'message' || message.id !== expected++ || processing) {
            reset();
            return;
        }
        processing = (async () => {
            const safe = parseHistoryPage({messages: [message.value]}, {chatId, limit: 1})
                .messages[0]!;
            await consume(safe);
            if (active) port.postMessage({type: 'ack', id: message.id});
        })()
            .catch(reset)
            .finally(() => {
                processing = undefined;
            });
    });
    return {
        stop: async () => {
            if (active) {
                active = false;
                port.postMessage({type: 'stop'});
            }
            await closed;
            await processing;
        },
        dispose: () => {
            active = false;
            port.close();
        },
    };
}
