import type {ReactionJournal, ReactionOperation} from './reaction-journal.ts';
import type {BackendController} from '../threema/backend-controller.ts';
import {BackendWorkerError} from '../threema/backend-controller.ts';

/** One pump under exclusive profile ownership. Preflight never implies a remote attempt. */
export class ReactionDispatcher {
    private readonly options: {
        profile: string;
        journal: ReactionJournal;
        backend: Pick<BackendController, 'reactMessage'>;
        ready: () => boolean;
        authorize: (operation: ReactionOperation) => Promise<void>;
    };
    private running?: Promise<number>;
    constructor(options: ReactionDispatcher['options']) {
        this.options = options;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid reaction batch size'));
        this.running ??= this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(limit: number): Promise<number> {
        const {journal, profile, backend} = this.options;
        const excluded: string[] = [];
        let sent = 0,
            failed = false;
        for (let attempt = 0; attempt < limit && this.options.ready(); attempt++) {
            const next = journal.next(profile, excluded);
            if (!next) break;
            try {
                await this.options.authorize(next.operation);
            } catch {
                excluded.push(next.operation.chat);
                failed = true;
                continue;
            }
            if (!this.options.ready()) break;
            const claimed = journal.claim(
                profile,
                {event: next.operation.event, part: next.part},
                excluded,
            );
            if (!claimed) continue;
            const {operation, part} = claimed;
            if (!journal.requiresRemoteMutation(profile, operation.event, part)) {
                journal.finish(profile, operation.event, part, 'SENT');
                sent++;
                continue;
            }
            try {
                await backend.reactMessage({
                    profile,
                    chatId: operation.chat,
                    messageId: operation.messages[part]!,
                    emoji: operation.emoji,
                    action: operation.action,
                });
            } catch (error) {
                if (
                    error instanceof BackendWorkerError &&
                    [
                        'reaction-invalid',
                        'reaction-permission-denied',
                        'reaction-not-found',
                    ].includes(error.code)
                ) {
                    journal.reject(profile, operation.event, part, error.code);
                    sent++;
                    continue;
                }
                journal.finish(profile, operation.event, part, 'OUTCOME_UNKNOWN');
                excluded.push(operation.chat);
                failed = true;
                continue;
            }
            journal.finish(profile, operation.event, part, 'SENT');
            sent++;
        }
        if (failed) throw new Error('Reaction work remains pending or uncertain');
        return sent;
    }
}
