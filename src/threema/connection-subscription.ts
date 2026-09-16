import type {MessagePort} from 'node:worker_threads';

/** Connection changes are transient. Port loss always reports disconnected. */
export async function serveConnection(
    port: MessagePort,
    attach: (changed: (connected: boolean) => void) => Promise<() => Promise<void>>,
): Promise<void> {
    let active = true;
    let unsubscribe: (() => Promise<void>) | undefined;
    const close = () => {
        if (!active) return;
        active = false;
        void Promise.resolve()
            .then(() => unsubscribe?.())
            .finally(() => port.close())
            .catch(() => undefined);
    };
    port.on('message', close);
    port.on('close', close);
    try {
        unsubscribe = await attach((connected) => {
            if (active) port.postMessage(connected);
        });
        if (!active) await unsubscribe();
    } catch (error) {
        close();
        throw error;
    }
}

export function receiveConnection(port: MessagePort, changed: (connected: boolean) => void) {
    let active = true;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });
    const report = (connected: boolean) => {
        try {
            changed(connected);
        } catch {
            /* Do not strand cleanup. */
        }
    };
    port.on('message', (value: unknown) => {
        if (!active) return;
        if (typeof value !== 'boolean') {
            report(false);
            port.close();
            return;
        }
        report(value);
    });
    port.on('close', () => {
        if (active) report(false);
        active = false;
        resolveClosed();
    });
    return {
        stop: async () => {
            if (active) {
                active = false;
                report(false);
                port.postMessage('stop');
            }
            await closed;
        },
        dispose: () => {
            active = false;
            report(false);
            port.close();
        },
    };
}
