import {unsupportedContent} from './unsupported-content.ts';
import {createHash} from 'node:crypto';
import type {NormalizedNodeMessage} from '../threema/history.ts';
import {encodeMessage, decodeMessage} from '../threema/message-codec.ts';
import type {EncryptedSender} from './encrypted-sender.ts';
import type {PortalStore} from './portal-store.ts';

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

/** Message-body projection only. Reactions, receipts and deletion need their own convergent actions. */
export class MessageDelivery {
    private readonly store: PortalStore;
    private readonly pending = new Map<string, Promise<unknown>>();
    private readonly renderMedia?: (
        message: NormalizedNodeMessage,
    ) => Promise<Record<string, unknown>>;
    constructor(
        store: PortalStore,
        renderMedia?: (message: NormalizedNodeMessage) => Promise<Record<string, unknown>>,
    ) {
        this.store = store;
        this.renderMedia = renderMedia;
    }
    deliver(
        profile: string,
        room: string,
        senderId: string,
        sender: Pick<EncryptedSender, 'send'>,
        value: NormalizedNodeMessage,
        operationId: string,
    ): Promise<string> {
        const message = decodeMessage(encodeMessage(value));
        if (!/^[A-Z0-9*][A-Z0-9]{7}$/.test(profile)) throw new Error('Invalid delivery profile');
        const key = JSON.stringify([profile, message.chatId, message.messageId]);
        const task = (this.pending.get(key) ?? Promise.resolve())
            .catch(() => {})
            .then(() => this.apply(profile, room, senderId, sender, message, operationId));
        this.pending.set(key, task);
        void task
            .finally(() => {
                if (this.pending.get(key) === task) this.pending.delete(key);
            })
            .catch(() => {});
        return task;
    }
    private async apply(
        profile: string,
        room: string,
        senderId: string,
        sender: Pick<EncryptedSender, 'send'>,
        message: NormalizedNodeMessage,
        id: string,
    ): Promise<string> {
        if (this.store.deletion(profile, message.chatId, message.messageId))
            throw new Error('Deleted message cannot be recreated');
        if (this.store.get(profile, message.chatId) !== room)
            throw new Error('Message target is not a mapped portal');
        let content: Record<string, unknown>;
        const unsupported = unsupportedContent(message);
        if (unsupported) content = unsupported;
        else if (message.content.type === 'text') {
            content = {
                msgtype: 'm.text',
                body: message.content.text,
            };
        } else if (
            this.renderMedia &&
            ['image', 'video', 'audio', 'file'].includes(message.content.type)
        ) {
            content = await this.renderMedia(message);
        } else throw new Error('Message content requires another projector');
        const base: Record<string, unknown> = {
            ...content,
            'com.threema.bridge': {
                message_id: message.messageId,
                created_at: message.createdAt.getTime(),
            },
        };
        // Fingerprint source semantics, not mutable local reply mappings or delivery receipts.
        const fingerprint = digest(
            JSON.stringify([
                profile,
                room,
                senderId,
                message.chatId,
                base,
                message.replyToMessageId ?? null,
            ]),
        );
        let plan = this.store.projection(id);
        if (plan && plan.fingerprint !== fingerprint)
            throw new Error('Message projection conflict');
        const old = this.store.messageMapping(profile, message.chatId, message.messageId);
        if (old && (old.room !== room || old.sender !== senderId))
            throw new Error('Message mapping identity changed');
        if (!plan && old?.digest === fingerprint) return old.latest;
        if (!plan) {
            if (message.replyToMessageId) {
                const reply = this.store.messageMapping(
                    profile,
                    message.chatId,
                    message.replyToMessageId,
                );
                if (reply?.room === room)
                    base['m.relates_to'] = {'m.in_reply_to': {event_id: reply.root}};
                else base['com.threema.reply_to'] = message.replyToMessageId;
            }
            const content = old
                ? {
                      ...base,
                      'body': `* ${base.body}`,
                      'm.new_content': base,
                      'm.relates_to': {rel_type: 'm.replace', event_id: old.root},
                  }
                : base;
            plan = this.store.prepareProjection({
                id,
                profile,
                chat: message.chatId,
                message: message.messageId,
                room,
                sender: senderId,
                fingerprint,
                digest: fingerprint,
                root: old?.root ?? null,
                content: JSON.stringify(content),
            });
        }
        const event = await sender.send(id, plan.room, 'm.room.message', JSON.parse(plan.content));
        this.store.finishProjection(id, event);
        return event;
    }
}
