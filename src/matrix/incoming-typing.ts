type Entry = {
    active: boolean;
    typing: boolean;
    version: number;
    sent?: boolean;
    at: number;
    stop?: () => Promise<void>;
};

/** Transient native contact state projected through existing Matrix ghosts. */
export class IncomingTyping {
    private readonly entries = new Map<string, Entry>();
    private stopped = false;
    private readonly options: {
        chats: () => readonly string[];
        ready: () => boolean;
        watch: (chat: string, changed: (typing: boolean) => void) => Promise<() => Promise<void>>;
        send: (chat: string, typing: boolean, current: () => boolean) => Promise<boolean>;
        now?: () => number;
    };
    constructor(options: IncomingTyping['options']) {
        this.options = options;
    }
    clear(): void {
        for (const entry of this.entries.values()) {
            entry.typing = false;
            entry.version++;
        }
    }
    async drain(): Promise<number> {
        if (this.stopped || !this.options.ready()) {
            this.clear();
            return 0;
        }
        const chats = new Set(
            this.options.chats().filter((chat) => /^c:[A-Z0-9*][A-Z0-9]{7}$/.test(chat)),
        );
        for (const [chat, entry] of this.entries) {
            if (!chats.has(chat)) {
                entry.active = false;
                this.entries.delete(chat);
                await entry.stop?.();
                // Matrix's short timeout clears indicators for removed portals.
            }
        }
        let completed = 0;
        for (const chat of chats) {
            if (this.stopped || !this.options.ready()) break;
            let entry = this.entries.get(chat);
            if (!entry) {
                entry = {active: true, typing: false, version: 0, at: 0};
                this.entries.set(chat, entry);
                const current = entry;
                try {
                    current.stop = await this.options.watch(chat, (typing) => {
                        if (!current.active || this.stopped) return;
                        current.typing = this.options.ready() && typing;
                        current.version++;
                    });
                    if (!current.active || this.stopped) await current.stop();
                } catch {
                    current.active = false;
                    this.entries.delete(chat);
                    continue;
                }
            }
            if (!entry.active || this.stopped || !this.options.ready()) continue;
            const now = this.options.now?.() ?? performance.now();
            if (entry.typing === entry.sent && (!entry.typing || now - entry.at < 5000)) continue;
            // No initial false request is necessary for an indicator we have never set.
            if (!entry.typing && entry.sent === undefined) continue;
            const typing = entry.typing,
                version = entry.version;
            try {
                const delivered = await this.options.send(
                    chat,
                    typing,
                    () =>
                        entry!.active &&
                        !this.stopped &&
                        this.options.ready() &&
                        entry!.version === version,
                );
                if (!delivered) continue;
                entry.sent = typing;
                entry.at = now;
                completed++;
            } catch {
                // Failed starts need fresh native state; never persist a retry.
                if (entry.version === version) entry.typing = false;
            }
        }
        return completed;
    }
    async stop(): Promise<void> {
        this.stopped = true;
        const entries = [...this.entries.values()];
        this.entries.clear();
        for (const entry of entries) entry.active = false;
        await Promise.allSettled(entries.map((entry) => entry.stop?.()));
    }
}
