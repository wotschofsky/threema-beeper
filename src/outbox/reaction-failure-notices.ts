import {createHash} from 'node:crypto';
import type {ReactionJournal, ReactionOperation} from './reaction-journal.ts';

const reasons: Record<string, string> = {
    'reaction-invalid': 'The emoji is not supported by this Threema version.',
    'reaction-permission-denied': 'The profile cannot react in this conversation.',
    'reaction-not-found': 'The original message is missing or deleted.',
};

export class ReactionFailureNotices {
    private readonly options: {
        profile: string;
        journal: ReactionJournal;
        ready: () => boolean;
        authorize: (operation: ReactionOperation) => Promise<void>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    private running?: Promise<number>;
    private cursor = {sequence: 0, part: -1};
    constructor(options: ReactionFailureNotices['options']) {
        this.options = options;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid reaction notice batch'));
        this.running ??= this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(limit: number): Promise<number> {
        if (!this.options.ready()) return 0;
        let completed = 0,
            failed = false;
        let page = this.options.journal.pendingFailures(this.options.profile, limit, this.cursor);
        if (!page.length && this.cursor.sequence) {
            this.cursor = {sequence: 0, part: -1};
            page = this.options.journal.pendingFailures(this.options.profile, limit, this.cursor);
        }
        for (const {sequence, operation, part, reason} of page) {
            if (!this.options.ready()) break;
            this.cursor = {sequence, part};
            try {
                if (!Object.hasOwn(reasons, reason))
                    throw new Error('Unknown reaction failure reason');
                await this.options.authorize(operation);
                if (!this.options.ready()) break;
                const id =
                    'reaction_failure_' +
                    createHash('sha256')
                        .update(
                            JSON.stringify([
                                operation.profile,
                                operation.room,
                                operation.event,
                                part,
                            ]),
                        )
                        .digest('hex');
                await this.options.send(id, operation.room, {
                    'msgtype': 'm.notice',
                    'body': `Threema rejected the reaction ${operation.action === 'withdraw' ? 'withdrawal' : 'apply'} for message part ${part + 1} of ${operation.messages.length}. ${reasons[reason]}`,
                    'm.relates_to': {'m.in_reply_to': {event_id: operation.event}},
                });
                this.options.journal.acknowledgeFailure(operation.profile, operation.event, part);
                completed++;
            } catch {
                failed = true;
            }
        }
        if (failed) throw new Error('Reaction failure notices remain pending');
        return completed;
    }
}
