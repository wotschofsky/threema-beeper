import {createHash} from 'node:crypto';
import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {NormalizedNodeMessage} from '../threema/history.ts';
import {decodeMessage, encodeMessage} from '../threema/message-codec.ts';
import type {PortalStore} from './portal-store.ts';
import type {EncryptedSender} from './encrypted-sender.ts';

/** Run in journal order. Group aggregate read state does not identify individual readers. */
export class StatusDelivery {
    private readonly store: PortalStore;
    constructor(store: PortalStore) {
        this.store = store;
    }
    async apply(
        profile: string,
        value: NormalizedNodeMessage,
        operationId: string,
        statusSender: Pick<EncryptedSender, 'send'>,
        receiptClient: (identity: string) => Promise<Pick<MatrixClient, 'sendReadReceipt'>>,
    ): Promise<void> {
        const message = decodeMessage(encodeMessage(value));
        if (this.store.deletion(profile, message.chatId, message.messageId)) return;
        const mapping = this.store.messageMapping(profile, message.chatId, message.messageId);
        if (!mapping || this.store.get(profile, message.chatId) !== mapping.room)
            throw new Error('Status target is not mapped');
        const old = this.store.messageStatus(profile, message.chatId, message.messageId);
        const timestamps: Record<string, number> = old ? JSON.parse(old) : {};
        for (const field of ['sentAt', 'deliveredAt', 'readAt'] as const) {
            const value = message[field]?.getTime();
            if (value !== undefined && (field === 'readAt' || message.direction === 'outbound'))
                timestamps[field] = Math.max(timestamps[field] ?? value, value);
        }
        // Fixed key order keeps retries independent of source field insertion order.
        const body = JSON.stringify(
            Object.fromEntries(Object.entries(timestamps).sort(([a], [b]) => a.localeCompare(b))),
        );
        if (body !== '{}' && body !== old) {
            const id =
                'status_' +
                createHash('sha256')
                    .update(
                        JSON.stringify([operationId, profile, message.chatId, message.messageId]),
                    )
                    .digest('hex');
            const statusEvent = await statusSender.send(
                id,
                mapping.room,
                'com.threema.message_status',
                {
                    'm.relates_to': {rel_type: 'm.reference', event_id: mapping.root},
                    'direction': message.direction,
                    timestamps,
                    // This describes upstream evidence, not transport or per-member guarantees.
                    'status':
                        timestamps.readAt !== undefined
                            ? 'read'
                            : timestamps.deliveredAt !== undefined
                              ? 'delivered'
                              : 'sent',
                },
            );
            this.store.bindReadTarget(profile, message.chatId, statusEvent, message.messageId);
            this.store.saveMessageStatus(profile, message.chatId, message.messageId, body);
        }
        if (timestamps.readAt === undefined) return;
        const reader =
            message.direction === 'inbound'
                ? profile
                : message.chatId.startsWith('c:')
                  ? message.chatId.slice(2)
                  : undefined;
        if (!reader) return;
        const position = this.store.receiptPosition(profile, message.chatId, reader);
        if (
            position &&
            (BigInt(position.ordinal) > message.ordinal ||
                (BigInt(position.ordinal) === message.ordinal &&
                    position.message >= message.messageId))
        )
            return;
        const client = await receiptClient(reader);
        await client.sendReadReceipt(mapping.room, mapping.root);
        this.store.saveReceiptPosition(
            profile,
            message.chatId,
            reader,
            message.ordinal,
            message.messageId,
        );
    }
}
