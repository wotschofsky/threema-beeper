import type {PortalStore} from '../matrix/portal-store.ts';
import type {NodeTypingRequest} from '../threema/typing-command.ts';

type Pending = {room: string; chat: string; typing: boolean; expires: number};
/** In-memory desired state only: disconnects and restarts discard typing, never replay it. */
export class TypingRuntime {
    private readonly pending = new Map<string, Pending>();
    private readonly sent = new Map<string, {typing: boolean; at: number}>();
    private running?: Promise<number>;
    private readonly options: {
        profile: string;
        owner: string;
        portals: Pick<PortalStore, 'portalForRoom'>;
        ready: () => boolean;
        authorize: (room: string, chat: string) => Promise<void>;
        setTyping: (request: NodeTypingRequest) => Promise<void>;
        now?: () => number;
    };
    constructor(options: TypingRuntime['options']) {
        this.options = options;
    }
    private now(): number {
        return this.options.now?.() ?? performance.now();
    }
    update(room: string, users: unknown): void {
        if (!this.options.ready()) {
            this.clear();
            return;
        }
        if (
            !Array.isArray(users) ||
            users.length > 10000 ||
            users.some((user) => typeof user !== 'string' || user.length > 1024)
        )
            return;
        const portal = this.options.portals.portalForRoom(room);
        if (portal?.profile !== this.options.profile || !portal.chat.startsWith('c:')) return;
        const typing = users.includes(this.options.owner);
        if (!typing && !this.pending.has(room) && !this.sent.has(room)) return;
        if (!this.pending.has(room) && this.pending.size >= 128) return;
        this.pending.set(room, {room, chat: portal.chat, typing, expires: this.now() + 15000});
    }
    clear(): void {
        this.pending.clear();
        this.sent.clear();
    }
    drain(): Promise<number> {
        this.running ??= this.process().finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(): Promise<number> {
        if (!this.options.ready()) {
            this.clear();
            return 0;
        }
        let completed = 0,
            failed = false;
        for (const [room, value] of this.pending) {
            const wanted = value.typing && value.expires > this.now();
            const prior = this.sent.get(room);
            if (wanted && prior?.typing && this.now() - prior.at < 2000) continue;
            try {
                await this.options.authorize(room, value.chat);
                if (!this.options.ready()) {
                    this.clear();
                    break;
                }
                if (this.pending.get(room) !== value) continue;
                const currentPortal = this.options.portals.portalForRoom(room);
                if (
                    currentPortal?.profile !== this.options.profile ||
                    currentPortal.chat !== value.chat
                ) {
                    this.pending.delete(room);
                    this.sent.delete(room);
                    continue;
                }
                const typing = value.typing && value.expires > this.now();
                await this.options.setTyping({
                    profile: this.options.profile,
                    chatId: value.chat,
                    typing,
                });
                if (!this.options.ready()) {
                    this.clear();
                    break;
                }
                this.sent.set(room, {typing, at: this.now()});
                if (!typing && this.pending.get(room) === value) {
                    this.pending.delete(room);
                    this.sent.delete(room);
                }
                completed++;
            } catch {
                // Typing is best effort. A failed update must not become a reconnect retry.
                if (this.pending.get(room) === value) this.pending.delete(room);
                this.sent.delete(room);
                failed = true;
            }
        }
        if (failed) throw new Error('Typing update could not be applied');
        return completed;
    }
}
