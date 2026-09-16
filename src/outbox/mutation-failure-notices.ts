import {createHash} from 'node:crypto';
import type {MutationJournal, MutationOperation} from './mutation-journal.ts';

const reasons: Record<string, string> = {
    'mutation-invalid': 'The requested change is invalid.',
    'mutation-permission-denied': 'The profile cannot change this message.',
    'mutation-not-found': 'The original message is missing or deleted.',
    'mutation-unsupported': 'This message change is not supported by the conversation.',
    'edit-window-expired': 'The time limit for editing this message has expired.',
    'delete-window-expired': 'The time limit for deleting this message has expired.',
};

export class MutationFailureNotices {
    private readonly options: {
        profile: string;
        journal: MutationJournal;
        ready: () => boolean;
        authorize: (operation: MutationOperation) => Promise<void>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    private running?: Promise<number>;
    private cursor = 0;
    constructor(options: MutationFailureNotices['options']) {
        this.options = options;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid mutation notice batch'));
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
        if (!page.length && this.cursor) {
            this.cursor = 0;
            page = this.options.journal.pendingFailures(this.options.profile, limit, this.cursor);
        }
        for (const {sequence, operation, part, reason, applied, cancelled} of page) {
            if (!this.options.ready()) break;
            this.cursor = sequence;
            try {
                if (!Object.hasOwn(reasons, reason))
                    throw new Error('Unknown mutation failure reason');
                await this.options.authorize(structuredClone(operation));
                if (!this.options.ready()) break;
                const id =
                    'mutation_failure_' +
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
                    'body': `Threema rejected the ${operation.commands[part]!.action === 'edit' ? 'edit' : 'deletion'} for message part ${part + 1} of ${operation.commands.length}. ${reasons[reason]} ${applied} earlier part(s) were applied; ${cancelled} remaining part(s) were not attempted.`,
                    'm.relates_to': {'m.in_reply_to': {event_id: operation.event}},
                });
                this.options.journal.acknowledgeFailure(operation.profile, operation.event, part);
                completed++;
            } catch {
                failed = true;
            }
        }
        if (failed) throw new Error('Mutation failure notices remain pending');
        return completed;
    }
}
