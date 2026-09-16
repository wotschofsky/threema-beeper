import {createHash} from 'node:crypto';
import type {ReactionJournal, ReactionOperation} from './reaction-journal.ts';
import type {BackendController} from '../threema/backend-controller.ts';

/** Reconcile a settled Matrix reference against fresh local backend state, not historical snapshots. */
export async function retireAbsentReaction(
    profile: string,
    event: string,
    options: {
        journal: ReactionJournal;
        backend: Pick<BackendController, 'reactionState'>;
        ready: () => boolean;
        authorize: (operation: ReactionOperation) => Promise<void>;
        redact: (id: string, room: string, event: string) => Promise<unknown>;
    },
): Promise<boolean> {
    if (!options.ready()) return false;
    const record = options.journal.get(profile, event);
    if (!record || record.operation.action !== 'apply') return false;
    const {operation} = record;
    const retirement = options.journal.retirement(profile, event);
    if (retirement?.done) return false;
    await options.authorize(operation);
    if (!options.ready()) return false;
    if (!retirement) {
        if (
            !operation.messages.some((message) =>
                options.journal
                    .activeReferences(profile, operation.chat, message)
                    .get(operation.emoji)
                    ?.includes(event),
            )
        )
            return false;
        if (
            record.states.some((state) => state !== 'SENT') ||
            options.journal.chatPending(profile, operation.chat)
        )
            return false;
        for (const messageId of operation.messages) {
            if (
                await options.backend.reactionState({
                    profile,
                    chatId: operation.chat,
                    messageId,
                    emoji: operation.emoji,
                    action: 'apply',
                })
            )
                return false;
        }
        if (!options.ready()) return false;
        options.journal.planRetirement(profile, event);
    }
    const id =
        'reaction_retire_' +
        createHash('sha256')
            .update(JSON.stringify([profile, operation.room, event]))
            .digest('hex');
    await options.redact(id, operation.room, event);
    options.journal.finishRetirement(profile, event);
    return true;
}

/** Cursor advances even when a candidate remains present or a lookup fails. */
export class ReactionRetirementWorker {
    private readonly profile: string;
    private readonly options: Parameters<typeof retireAbsentReaction>[2];
    private cursor = 0;
    private running?: Promise<number>;
    constructor(profile: string, options: Parameters<typeof retireAbsentReaction>[2]) {
        this.profile = profile;
        this.options = options;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid retirement batch'));
        this.running ??= this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(limit: number): Promise<number> {
        if (!this.options.ready()) return 0;
        let page = this.options.journal.retirementCandidates(this.profile, this.cursor, limit);
        if (!page.length && this.cursor) {
            this.cursor = 0;
            page = this.options.journal.retirementCandidates(this.profile, 0, limit);
        }
        let completed = 0,
            failed = false;
        for (const row of page) {
            if (!this.options.ready()) break;
            this.cursor = row.sequence;
            try {
                if (await retireAbsentReaction(this.profile, row.event, this.options)) completed++;
            } catch {
                failed = true;
            }
        }
        if (failed) throw new Error('Reaction retirement checks remain pending');
        return completed;
    }
}
