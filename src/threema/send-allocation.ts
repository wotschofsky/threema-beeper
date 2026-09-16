import type {MessagePort} from 'node:worker_threads';

export interface TextSendRequest {
    profile: string;
    chatId: string;
    text: string;
    replyTo?: string;
}
export function parseTextSend(value: unknown): TextSendRequest {
    const v = value as Partial<TextSendRequest> | null;
    if (
        !v ||
        typeof v !== 'object' ||
        typeof v.profile !== 'string' ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(v.profile) ||
        typeof v.chatId !== 'string' ||
        !/^(c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(v.chatId) ||
        typeof v.text !== 'string' ||
        !v.text ||
        Buffer.byteLength(v.text) > 1024 * 1024 ||
        (v.replyTo !== undefined &&
            (typeof v.replyTo !== 'string' || !/^m:[0-9a-f]{16}$/.test(v.replyTo)))
    )
        throw new Error('Invalid text send request');
    return {
        profile: v.profile,
        chatId: v.chatId,
        text: v.text,
        ...(v.replyTo === undefined ? {} : {replyTo: v.replyTo}),
    };
}
export function parseAllocatedIds(value: unknown): string[] {
    if (
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > 1024 ||
        new Set(value).size !== value.length ||
        value.some((id) => typeof id !== 'string' || !/^m:[0-9a-f]{16}$/.test(id))
    )
        throw new Error('Invalid send allocation');
    return [...value] as string[];
}

/** Worker-side barrier. A closed channel can never grant permission to send. */
export class SendAllocation {
    private readonly port: MessagePort;
    private readonly timeoutMs: number;
    private closed = false;
    private used = false;
    private rejectPending?: () => void;
    constructor(port: MessagePort, timeoutMs = 30_000) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
            throw new Error('Invalid allocation timeout');
        this.port = port;
        this.timeoutMs = timeoutMs;
        port.once('close', () => {
            this.closed = true;
            this.rejectPending?.();
        });
    }
    async record(value: readonly string[]): Promise<void> {
        const ids = parseAllocatedIds(value);
        if (this.closed || this.used) throw new Error('SEND_ALLOCATION_FAILED');
        this.used = true;
        await new Promise<void>((resolve, reject) => {
            const fail = () => finish(false);
            const finish = (ok: boolean) => {
                clearTimeout(timer);
                this.port.off('message', receive);
                this.rejectPending = undefined;
                if (ok) resolve();
                else reject(new Error('SEND_ALLOCATION_FAILED'));
            };
            const receive = (message: unknown) => {
                const reply = message as {type?: unknown} | null;
                finish(reply?.type === 'allocation-committed');
            };
            const timer = setTimeout(fail, this.timeoutMs);
            this.rejectPending = fail;
            this.port.once('message', receive);
            this.port.postMessage({type: 'allocated', ids});
        });
    }
    close(): void {
        this.closed = true;
        this.rejectPending?.();
        this.port.close();
    }
}

/** Parent-side handler: only acknowledge after durable persistence resolves. */
export function acceptSendAllocation(
    port: MessagePort,
    persist: (ids: readonly string[]) => Promise<void>,
): {result(value: unknown): string[]; close(): void} {
    let seen = false,
        closed = false;
    let committed: string[] | undefined;
    port.once('close', () => {
        closed = true;
    });
    port.on('message', (message: unknown) => {
        void (async () => {
            try {
                if (seen || closed) throw new Error('Unexpected allocation');
                seen = true;
                const data = message as {type?: unknown; ids?: unknown} | null;
                if (data?.type !== 'allocated') throw new Error('Invalid allocation');
                const ids = parseAllocatedIds(data.ids);
                await persist([...ids]);
                if (closed) return;
                committed = ids;
                port.postMessage({type: 'allocation-committed'});
            } catch {
                closed = true;
                port.close();
            }
        })();
    });
    return {
        result(value) {
            const ids = parseAllocatedIds(value);
            if (!committed || JSON.stringify(ids) !== JSON.stringify(committed))
                throw new Error('Send result does not match committed allocation');
            return ids;
        },
        close() {
            closed = true;
            port.close();
        },
    };
}
