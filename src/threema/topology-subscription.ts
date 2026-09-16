import type {MessagePort} from 'node:worker_threads';

/** Payload-free invalidation stream; close also invalidates an active parent subscription. */
export async function serveTopology(
    port: MessagePort,
    attach: (reset: () => void) => Promise<() => Promise<void>>,
): Promise<void> {
    let active = true;
    let unsubscribe: (() => Promise<void>) | undefined;
    function close(invalidated: boolean): void {
        if (!active) return;
        active = false;
        if (invalidated) port.postMessage({type: 'reset'});
        void Promise.resolve()
            .then(() => unsubscribe?.())
            .finally(() => port.close())
            .catch(() => undefined);
    }
    port.on('message', () => close(false));
    port.on('close', () => close(false));
    try {
        unsubscribe = await attach(() => close(true));
        if (!active) await unsubscribe();
    } catch (error) {
        close(true);
        throw error;
    }
}

export function receiveTopology(
    port: MessagePort,
    onReset: () => void,
): {stop: () => Promise<void>; dispose: () => void} {
    let active = true;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });
    function reset(): void {
        if (!active) return;
        active = false;
        try {
            onReset();
        } catch {
            /* Reporting cannot strand the subscription. */
        }
        port.close();
    }
    port.on('message', reset);
    port.on('close', () => {
        reset();
        resolveClosed();
    });
    return {
        stop: async () => {
            if (active) {
                active = false;
                port.postMessage({type: 'stop'});
            }
            await closed;
        },
        dispose: () => {
            active = false;
            port.close();
        },
    };
}
