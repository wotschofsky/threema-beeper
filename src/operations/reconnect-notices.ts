import {createHash} from 'node:crypto';
import {observeReconnect, parseReconnectState, type ReconnectState} from './reconnect-policy.ts';

const fingerprint = (state: ReconnectState | undefined) => {
    if (!state) return '';
    const {observedAt: _observedAt, ...semantic} = state;
    return JSON.stringify(semantic);
};
export class ReconnectNotices {
    private state?: ReconnectState;
    private saved: string;
    private readonly options: {
        owner: string;
        initial?: ReconnectState;
        now: () => number;
        persist: (state: ReconnectState) => Promise<void>;
        ready: () => boolean;
        delivered: (id: string) => boolean;
        authorize: () => Promise<string>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    constructor(options: ReconnectNotices['options']) {
        this.options = options;
        this.state = options.initial ? parseReconnectState(options.initial) : undefined;
        this.saved = fingerprint(this.state);
        if (this.state) {
            // Time while the process was absent is not evidence of continuous connection/outage.
            delete this.state.connected;
            delete this.state.stableSince;
            delete this.state.disconnectedAt;
        }
    }
    observe(connected: boolean): void {
        this.state = observeReconnect(this.state, connected, this.options.now());
    }
    async drain(): Promise<number> {
        // Observe duration even when Matrix cannot deliver a warning yet.
        if (this.state?.connected !== undefined) this.observe(this.state.connected);
        const snapshot = this.state ? parseReconnectState(this.state) : undefined;
        if (!snapshot) return 0;
        const key = fingerprint(snapshot);
        if (key !== this.saved) {
            await this.options.persist(snapshot);
            this.saved = key;
        }
        if (!snapshot.revision || !this.options.ready()) return 0;
        const id = 'reconnect_' + createHash('sha256').update(JSON.stringify([
            this.options.owner, snapshot.revision,
        ])).digest('hex');
        if (this.options.delivered(id)) return 0;
        const room = await this.options.authorize();
        if (!this.options.ready()) return 0;
        await this.options.send(id, room, {msgtype: 'm.notice', body:
            'The Threema connection has repeatedly disconnected or remained offline for at least ten minutes. Check bridge status, network access and the linked-device status on your phone. It may have recovered since this warning was recorded. Queued messages and uncertain sends retain their existing recovery safeguards.'});
        return 1;
    }
}
