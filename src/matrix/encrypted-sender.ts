import {createHash} from 'node:crypto';
import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {PortalStore} from './portal-store.ts';

export interface EncryptedIntent {
    userId: string;
    enableEncryption(): Promise<void>;
    underlyingClient: Pick<MatrixClient, 'crypto' | 'getRoomStateEventContent' | 'doRequest'>;
}
const algorithm = 'm.megolm.v1.aes-sha2';

/** Snapshot caller-owned JSON before awaiting; reject values JSON would silently coerce. */
function canonical(value: unknown): string {
    let nodes = 0;
    function visit(item: unknown, depth: number): unknown {
        if (++nodes > 100_000 || depth > 20) throw new Error('Event content exceeds limits');
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
        if (typeof item === 'number' && Number.isFinite(item)) return item;
        if (Array.isArray(item)) return Array.from(item, (entry) => visit(entry, depth + 1));
        if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
            return Object.fromEntries(
                Object.keys(item)
                    .sort()
                    .map((key) => [key, visit((item as Record<string, unknown>)[key], depth + 1)]),
            );
        }
        throw new Error('Event content must be finite JSON');
    }
    const json = JSON.stringify(visit(value, 0));
    if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new Error('Event content exceeds limits');
    return json;
}

/** Caller must supply a verified portal and an intent joined to that portal. */
export class EncryptedSender {
    private readonly intent: EncryptedIntent;
    private readonly store: PortalStore;
    private readonly pending = new Map<string, {digest: string; task: Promise<string>}>();
    constructor(intent: EncryptedIntent, store: PortalStore) {
        this.intent = intent;
        this.store = store;
    }
    async send(
        id: string,
        room: string,
        type: string,
        content: Record<string, unknown>,
    ): Promise<string> {
        if (
            !/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
            !/^![^\s]+:[^\s]+$/.test(room) ||
            !/^@[^\s]+:[^\s]+$/.test(this.intent.userId) ||
            !/^[A-Za-z0-9_.-]{1,255}$/.test(type) ||
            type === 'm.room.encrypted' ||
            !content ||
            Array.isArray(content)
        )
            throw new Error('Invalid encrypted event request');
        const body = canonical(content);
        const digest = createHash('sha256')
            .update(canonical([this.intent.userId, room, type, JSON.parse(body)]))
            .digest('hex');
        const existing = this.pending.get(id);
        if (existing) {
            if (existing.digest !== digest) throw new Error('Encrypted operation conflict');
            return existing.task;
        }
        const task = this.deliver(id, room, type, body, digest).finally(() =>
            this.pending.delete(id),
        );
        this.pending.set(id, {digest, task});
        return task;
    }
    private async deliver(
        id: string,
        room: string,
        type: string,
        body: string,
        digest: string,
    ): Promise<string> {
        let operation = this.store.operation(id);
        if (
            operation &&
            (operation.digest !== digest ||
                operation.sender !== this.intent.userId ||
                operation.room !== room)
        )
            throw new Error('Encrypted operation conflict');
        if (operation?.event) return operation.event;
        await this.intent.enableEncryption();
        const client = this.intent.underlyingClient;
        const state = await client.getRoomStateEventContent(room, 'm.room.encryption', '');
        if (state.algorithm !== algorithm || !client.crypto)
            throw new Error('Room encryption is unavailable');
        if (!operation) {
            const encrypted = await client.crypto.encryptRoomEvent(room, type, JSON.parse(body));
            if (
                encrypted.algorithm !== algorithm ||
                ![
                    encrypted.ciphertext,
                    encrypted.session_id,
                    encrypted.sender_key,
                    encrypted.device_id,
                ].every((value) => typeof value === 'string' && value.length > 0)
            )
                throw new Error('Invalid encrypted event');
            operation = this.store.prepareOperation({
                id,
                sender: this.intent.userId,
                room,
                digest,
                ciphertext: canonical(encrypted),
            });
        }
        const response = await client.doRequest(
            'PUT',
            `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.encrypted/${encodeURIComponent(id)}`,
            null,
            JSON.parse(operation.ciphertext),
        );
        if (
            !response ||
            typeof response.event_id !== 'string' ||
            !/^\$[^\s]{1,1024}$/.test(response.event_id)
        )
            throw new Error('Invalid Matrix event response');
        this.store.completeOperation(id, response.event_id);
        return response.event_id;
    }
}
