import assert from 'node:assert/strict';
import {
    EncryptedRoomEvent,
    MatrixClient,
} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';

type SyncArguments = Parameters<MatrixClient['crypto']['updateSyncData']>;
type ToDeviceEvent = SyncArguments[0][number] & {
    to_user_id: string;
    to_device_id: string;
};
interface TimelineEvent {
    room_id: string;
    event_id: string;
    sender: string;
    type: string;
    content: Record<string, unknown>;
    [key: string]: unknown;
}
/** Stable appservice crypto fields and legacy aliases. Authentication belongs to the caller. */
export interface NativeTransaction {
    'events': TimelineEvent[];
    'to_device'?: ToDeviceEvent[];
    'device_lists'?: {changed?: string[]; left?: string[]; removed?: string[]};
    'device_one_time_keys_count'?: Record<string, Record<string, Record<string, number>>>;
    'device_unused_fallback_key_types'?: Record<string, Record<string, SyncArguments[2]>>;
    'de.sorunome.msc2409.to_device'?: ToDeviceEvent[];
    'org.matrix.msc3202.device_lists'?: {changed?: string[]; left?: string[]; removed?: string[]};
    'org.matrix.msc3202.device_one_time_keys_count'?: Record<
        string,
        Record<string, Record<string, number>>
    >;
    'org.matrix.msc3202.device_unused_fallback_key_types'?: Record<
        string,
        Record<string, SyncArguments[2]>
    >;
}

/**
 * Gate 0 transaction adapter. Uses already-open native clients, never creates identities on input.
 * The caller must persist the transaction before calling and await this before acknowledging it.
 * Durable retries and deduplication are not implemented by this experiment.
 */
export async function processNativeTransaction(
    transaction: NativeTransaction,
    clients: ReadonlyMap<string, MatrixClient>,
    clientForRoom: (roomId: string) => MatrixClient,
    onEvent: (event: TimelineEvent) => Promise<void>,
): Promise<void> {
    assert.ok(Array.isArray(transaction.events), 'Transaction requires an events array');
    const pending = new Map<string, ToDeviceEvent[]>();
    for (const event of transaction.to_device ??
        transaction['de.sorunome.msc2409.to_device'] ??
        []) {
        const client = clients.get(event.to_user_id);
        assert.ok(client?.crypto.isReady, 'Unknown or unready crypto recipient');
        assert.equal(
            event.to_device_id,
            client.crypto.clientDeviceId,
            'Unexpected recipient device',
        );
        // Beeper acknowledges persisted keys so clients may retire outbound sessions.
        // This bridge retains them; the acknowledgement has no crypto side effect here.
        if (event.type === 'com.beeper.room_key.ack') continue;
        assert.equal(
            event.type,
            'm.room.encrypted',
            'This spike only supports encrypted to-device payloads',
        );
        const events = pending.get(event.to_user_id) ?? [];
        events.push(event);
        pending.set(event.to_user_id, events);
    }
    const counts =
        transaction.device_one_time_keys_count ??
        transaction['org.matrix.msc3202.device_one_time_keys_count'] ??
        {};
    const fallbacks =
        transaction.device_unused_fallback_key_types ??
        transaction['org.matrix.msc3202.device_unused_fallback_key_types'] ??
        {};
    // The server includes inventory for inactive/retired ghosts too. Only the already-open
    // clients below consume counts; unrelated inventory must not block active room keys.
    // Actual to-device payloads still require a known recipient and exact device above.
    const deviceLists = transaction.device_lists ?? transaction['org.matrix.msc3202.device_lists'];
    const changed = deviceLists?.changed ?? [];
    const left = deviceLists?.left ?? deviceLists?.removed ?? [];
    for (const [userId, client] of clients) {
        const deviceId = client.crypto.clientDeviceId;
        const messages = pending.get(userId) ?? [];
        const keyCounts = counts[userId]?.[deviceId];
        const unused = fallbacks[userId]?.[deviceId];
        if (messages.length || keyCounts || unused || changed.length || left.length) {
            await client.crypto.updateSyncData(
                // The native engine accepts these Matrix event payloads directly.
                messages,
                keyCounts ?? {},
                unused ?? [],
                changed,
                left,
            );
        }
    }
    for (const event of transaction.events) {
        let clear = event;
        if (event.type === 'm.room.encrypted') {
            const client = clientForRoom(event.room_id);
            assert.ok(client.crypto.isReady, 'Room crypto is not ready');
            const decrypted = await client.crypto.decryptRoomEvent(
                new EncryptedRoomEvent(event),
                event.room_id,
            );
            clear = decrypted.raw as TimelineEvent;
        }
        // Await delivery: an async handler failure must prevent transaction acknowledgement.
        await onEvent({...clear, encrypted: event.type === 'm.room.encrypted'});
    }
}
