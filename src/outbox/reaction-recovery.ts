import type {ReactionJournal, ReactionOperation} from './reaction-journal.ts';
import type {BackendController} from '../threema/backend-controller.ts';

/** Settle only when the current backend state already satisfies the uncertain operation. */
export class ReactionRecovery {
    private readonly options: {
        profile: string;
        journal: ReactionJournal;
        backend: Pick<BackendController, 'reactionState'>;
        ready: () => boolean;
        authorize: (operation: ReactionOperation) => Promise<void>;
    };
    private running?: Promise<number>;
    private cursor = {sequence: 0, part: -1};
    constructor(options: ReactionRecovery['options']) {
        this.options = options;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid reaction recovery batch'));
        this.running ??= this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(limit: number): Promise<number> {
        if (!this.options.ready()) return 0;
        let completed = 0,
            failed = false;
        let page = this.options.journal.uncertain(this.options.profile, limit, this.cursor);
        if (!page.length && this.cursor.sequence) {
            this.cursor = {sequence: 0, part: -1};
            page = this.options.journal.uncertain(this.options.profile, limit, this.cursor);
        }
        for (const {sequence, operation, part} of page) {
            if (!this.options.ready()) break;
            this.cursor = {sequence, part};
            try {
                await this.options.authorize(operation);
                if (!this.options.ready()) break;
                const present = await this.options.backend.reactionState({
                    profile: operation.profile,
                    chatId: operation.chat,
                    messageId: operation.messages[part]!,
                    emoji: operation.emoji,
                    action: operation.action,
                });
                if (!this.options.ready()) break;
                if (
                    this.options.journal.observeDesiredState(
                        operation.profile,
                        operation.event,
                        part,
                        present,
                    )
                )
                    completed++;
            } catch {
                failed = true;
            }
        }
        if (failed) throw new Error('Reaction recovery checks remain pending');
        return completed;
    }
}
