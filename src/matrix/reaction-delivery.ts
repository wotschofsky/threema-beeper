import {createHash} from 'node:crypto';
import type {NormalizedNodeMessage} from '../threema/history.ts';
import {decodeMessage, encodeMessage} from '../threema/message-codec.ts';
import type {PortalStore} from './portal-store.ts';
import type {EncryptedSender} from './encrypted-sender.ts';
import type {RedactionSender} from './redaction-sender.ts';
import type {ReactionJournal} from '../outbox/reaction-journal.ts';

/** Call in journal order after the message body and membership have converged. */
export class ReactionDelivery {
    private readonly store: PortalStore;
    private readonly outbound?: Pick<ReactionJournal, 'activeReferences'>;
    private readonly ownerState?: (
        chat: string,
        message: string,
        emoji: string,
    ) => Promise<boolean>;
    constructor(
        store: PortalStore,
        outbound?: Pick<ReactionJournal, 'activeReferences'>,
        ownerState?: (chat: string, message: string, emoji: string) => Promise<boolean>,
    ) {
        this.store = store;
        this.outbound = outbound;
        this.ownerState = ownerState;
    }
    async reconcile(
        profile: string,
        value: NormalizedNodeMessage,
        operationId: string,
        senderFor: (identity: string) => Promise<Pick<EncryptedSender, 'send'>>,
        redactor: Pick<RedactionSender, 'redact'>,
    ): Promise<void> {
        const message = decodeMessage(encodeMessage(value));
        if (this.store.deletion(profile, message.chatId, message.messageId))
            throw new Error('Deleted message cannot receive reactions');
        const mapping = this.store.messageMapping(profile, message.chatId, message.messageId);
        if (!mapping || this.store.get(profile, message.chatId) !== mapping.room)
            throw new Error('Reaction target is not mapped');
        const key = (identity: string, emoji: string) => JSON.stringify([identity, emoji]);
        const desired = new Map(
            message.reactions.map((reaction) => [
                key(reaction.senderIdentity, reaction.emoji),
                reaction,
            ]),
        );
        const existing = this.store.reactions(profile, message.chatId, message.messageId);
        // Owner controls can advance while an older inbound snapshot is waiting in the journal.
        // Check all owner emojis involved in this projection before making any Matrix change.
        if (this.ownerState) {
            const emojis = new Set([
                ...message.reactions
                    .filter((reaction) => reaction.senderIdentity === profile)
                    .map((reaction) => reaction.emoji),
                ...existing
                    .filter((reaction) => reaction.identity === profile)
                    .map((reaction) => reaction.emoji),
            ]);
            for (const emoji of emojis) {
                const present = await this.ownerState(message.chatId, message.messageId, emoji);
                if (!present) desired.delete(key(profile, emoji));
                else if (
                    existing.some(
                        (reaction) => reaction.identity === profile && reaction.emoji === emoji,
                    )
                )
                    desired.set(key(profile, emoji), {
                        senderIdentity: profile,
                        emoji,
                        reactedAt: message.createdAt,
                    });
            }
        }
        const ownerReferences = this.outbound?.activeReferences(
            profile,
            message.chatId,
            message.messageId,
        );
        const id = (action: string, identity: string, emoji: string, event = '') =>
            'reaction_' +
            createHash('sha256')
                .update(
                    JSON.stringify([
                        operationId,
                        profile,
                        message.chatId,
                        message.messageId,
                        action,
                        identity,
                        emoji,
                        event,
                    ]),
                )
                .digest('hex');
        for (const old of existing) {
            if (
                desired.has(key(old.identity, old.emoji)) &&
                !(old.identity === profile && ownerReferences?.has(old.emoji))
            )
                continue;
            await redactor.redact(
                id('remove', old.identity, old.emoji, old.event),
                mapping.room,
                old.event,
            );
            this.store.removeReaction(
                profile,
                message.chatId,
                message.messageId,
                old.identity,
                old.emoji,
                old.event,
            );
        }
        const known = new Set(existing.map((reaction) => key(reaction.identity, reaction.emoji)));
        for (const reaction of desired.values()) {
            if (reaction.senderIdentity === profile && ownerReferences?.has(reaction.emoji))
                continue;
            if (known.has(key(reaction.senderIdentity, reaction.emoji))) continue;
            const sender = await senderFor(reaction.senderIdentity);
            const event = await sender.send(
                id('add', reaction.senderIdentity, reaction.emoji),
                mapping.room,
                'm.reaction',
                {
                    'm.relates_to': {
                        rel_type: 'm.annotation',
                        event_id: mapping.root,
                        key: reaction.emoji,
                    },
                },
            );
            this.store.bindReaction(
                profile,
                message.chatId,
                message.messageId,
                reaction.senderIdentity,
                reaction.emoji,
                event,
            );
        }
    }
}
