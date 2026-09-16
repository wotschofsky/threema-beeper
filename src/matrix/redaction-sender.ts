import {createHash} from 'node:crypto';
import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {PortalStore} from './portal-store.ts';

/** Matrix redactions are control requests, not encrypted message payloads. */
export class RedactionSender {
    private readonly store: PortalStore;
    private readonly intent: {
        userId: string;
        enableEncryption(): Promise<void>;
        underlyingClient: Pick<MatrixClient, 'doRequest'>;
    };
    constructor(store: PortalStore, intent: RedactionSender['intent']) {
        this.store = store;
        this.intent = intent;
    }
    async redact(id: string, room: string, target: string): Promise<string> {
        if (
            !/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
            !/^![^\s]+:[^\s]+$/.test(room) ||
            !/^\$[^\s]{1,1024}$/.test(target)
        )
            throw new Error('Invalid redaction request');
        const sender = this.intent.userId;
        const digest = createHash('sha256')
            .update(JSON.stringify(['redact', sender, room, target]))
            .digest('hex');
        const operation = this.store.prepareOperation({id, sender, room, digest, ciphertext: '{}'});
        if (operation.event) return operation.event;
        await this.intent.enableEncryption();
        const response = await this.intent.underlyingClient.doRequest(
            'PUT',
            `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/redact/${encodeURIComponent(target)}/${encodeURIComponent(id)}`,
            null,
            {},
        );
        if (
            !response ||
            typeof response.event_id !== 'string' ||
            !/^\$[^\s]{1,1024}$/.test(response.event_id)
        )
            throw new Error('Invalid redaction response');
        this.store.completeOperation(id, response.event_id);
        return response.event_id;
    }
}
