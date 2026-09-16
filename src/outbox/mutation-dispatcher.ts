import {BackendWorkerError, type BackendController} from '../threema/backend-controller.ts';
import type {MutationJournal, MutationOperation} from './mutation-journal.ts';

/** Persist dispatch before invoking native mutation; uncertain outcomes never re-enter this loop. */
export class MutationDispatcher {
    private readonly options: {
        profile: string;
        journal: MutationJournal;
        backend: Pick<BackendController, 'mutateMessage'> &
            Partial<Pick<BackendController, 'mutationState'>>;
        ready: () => boolean;
        authorize: (operation: MutationOperation) => Promise<void>;
    };
    private running?: Promise<number>;
    constructor(options: MutationDispatcher['options']) {
        this.options = options;
    }
    drain(limit = 100): Promise<number> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new Error('Invalid mutation batch size'));
        this.running ??= this.process(limit).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private async process(limit: number): Promise<number> {
        const {journal, profile, backend} = this.options;
        const excluded: string[] = [];
        let completed = 0,
            failed = false;
        for (let attempt = 0; attempt < limit && this.options.ready(); attempt++) {
            const next = journal.peek(profile, excluded);
            if (!next) break;
            const {operation, part} = next;
            let alreadyDeleted = false;
            try {
                await this.options.authorize(structuredClone(operation));
                if (!this.options.ready()) break;
                if (operation.commands[part]!.action === 'delete' && backend.mutationState) {
                    alreadyDeleted = await backend.mutationState(
                        structuredClone(operation.commands[part]!),
                    );
                    if (typeof alreadyDeleted !== 'boolean')
                        throw new Error('Invalid native deletion state');
                    await this.options.authorize(structuredClone(operation));
                }
            } catch {
                excluded.push(operation.chat);
                failed = true;
                continue;
            }
            if (!this.options.ready()) break;
            if (!journal.claim(profile, operation.event, part, excluded)) continue;
            if (alreadyDeleted) {
                journal.finish(profile, operation.event, part, 'APPLIED');
                completed++;
                continue;
            }
            try {
                await backend.mutateMessage(operation.commands[part]!);
            } catch (error) {
                if (
                    error instanceof BackendWorkerError &&
                    [
                        'mutation-invalid',
                        'mutation-permission-denied',
                        'mutation-not-found',
                        'mutation-unsupported',
                        'edit-window-expired',
                        'delete-window-expired',
                    ].includes(error.code)
                ) {
                    journal.finish(profile, operation.event, part, 'REJECTED', error.code);
                    completed++;
                    continue;
                }
                journal.finish(profile, operation.event, part, 'OUTCOME_UNKNOWN');
                excluded.push(operation.chat);
                failed = true;
                continue;
            }
            // A failed completion commit leaves DISPATCHING for restart recovery, never PREPARED.
            journal.finish(profile, operation.event, part, 'APPLIED');
            completed++;
        }
        if (failed) throw new Error('Mutation work remains pending or uncertain');
        return completed;
    }
}
