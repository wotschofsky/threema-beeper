import type {TransactionInbox} from '../matrix/transaction-inbox.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {OutboxStore} from './store.ts';

/** Wait for earlier local sends, without creating a dependency on a future source event. */
export function resolveReplyTarget(options: {
    profile: string;
    owner: string;
    room: string;
    chat: string;
    event: string;
    target: string;
    inbox: TransactionInbox;
    portals: PortalStore;
    outbox: OutboxStore;
}): string | undefined {
    const {profile, owner, room, chat, event, target, inbox, portals, outbox} = options;
    const text = outbox.forEvent(profile, target);
    const media = outbox.media.get(profile, target);
    if (text || media) {
        const destination = text
            ? {room: text.request.roomId, chat: text.request.chatId, owner: text.request.sender}
            : {
                  room: media!.request.room,
                  chat: media!.request.media.chat,
                  owner: media!.request.owner,
              };
        if (destination.room !== room || destination.chat !== chat || destination.owner !== owner)
            return undefined;
        const confirmed = text ? ['SENT', 'ACKED'].includes(text.state) : media!.state === 'SENT';
        const ids = text?.ids ?? media!.ids;
        if (confirmed && ids.length === 1) return ids[0];
        if (!confirmed && inbox.eventPrecedes(target, event))
            throw new Error('Reply target send remains pending or uncertain');
        // Never let a partly committed mapping override uncertain local-send state.
        return undefined;
    }
    return portals.messageForEvent(profile, chat, target);
}
