import type {NormalizedNodeMessage} from '../threema/history.ts';

/** Local model insertion alone does not establish upstream transport acceptance. */
export function hasOutboundDeliveryEvidence(message: NormalizedNodeMessage): boolean {
    return (
        message.direction === 'outbound' &&
        (message.sentAt !== undefined ||
            message.deliveredAt !== undefined ||
            message.readAt !== undefined)
    );
}
