import {createHash} from 'node:crypto';
import type {PortalStore} from './portal-store.ts';
import type {RedactionSender} from './redaction-sender.ts';

/** Persist a permanent deletion marker before redacting any visible version. */
export class DeletionDelivery {
    private readonly store: PortalStore;
    constructor(store: PortalStore) {
        this.store = store;
    }
    async apply(
        profile: string,
        chat: string,
        message: string,
        room: string,
        redactor: Pick<RedactionSender, 'redact'>,
    ): Promise<void> {
        if (this.store.get(profile, chat) !== room)
            throw new Error('Deletion target is not a mapped portal');
        if (this.store.deletion(profile, chat, message)?.done) return;
        this.store.beginDeletion(profile, chat, message);
        const versions = this.store.versionsForDeletion(profile, chat, message);
        const remove = async (event: string) => {
            const id =
                'delete_' +
                createHash('sha256')
                    .update(JSON.stringify([profile, chat, message, room, event]))
                    .digest('hex');
            await redactor.redact(id, room, event);
        };
        for (const event of versions) {
            await remove(event);
            this.store.markVersionRedacted(profile, chat, message, event);
        }
        for (const reaction of this.store.reactions(profile, chat, message)) {
            await remove(reaction.event);
            this.store.removeReaction(
                profile,
                chat,
                message,
                reaction.identity,
                reaction.emoji,
                reaction.event,
            );
        }
        this.store.finishDeletion(profile, chat, message);
    }
}
