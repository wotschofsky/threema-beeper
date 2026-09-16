import {createHash} from 'node:crypto';
import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import {
    managementRoomState,
    assertManagementRoomState,
    assertProvisionedManagementRoomState,
    type ManagementRoomIdentity,
} from './room-policy.ts';

interface ManagementIntent {
    userId: string;
    enableEncryption(): Promise<void>;
    underlyingClient: Pick<MatrixClient, 'resolveRoom' | 'createRoom' | 'getRoomState'>;
}

function errorCode(error: unknown): unknown {
    return error && typeof error === 'object' ? (error as {errcode?: unknown}).errcode : undefined;
}

/** Stable alias recovers creation across restarts; all reuse requires fresh state verification. */
export class ManagementRoom {
    private readonly intent: ManagementIntent;
    private readonly identity: ManagementRoomIdentity;
    private readonly localpart: string;
    readonly alias: string;
    private pending?: Promise<string>;

    constructor(
        intent: ManagementIntent,
        options: {
            profile: string;
            owner: string;
            domain: string;
            namespace: string;
            assertAlias: (alias: string) => void;
        },
    ) {
        this.intent = intent;
        this.identity = {profile: options.profile, owner: options.owner, bot: intent.userId};
        managementRoomState(this.identity);
        if (
            !/^[a-z0-9-]{1,32}$/.test(options.namespace) ||
            !/^[A-Za-z0-9.:-]+$/.test(options.domain)
        )
            throw new Error('Invalid management room configuration');
        this.localpart = `${options.namespace}_management_${createHash('sha256')
            .update(JSON.stringify(this.identity))
            .digest('hex')
            .slice(0, 40)}`;
        this.alias = `#${this.localpart}:${options.domain}`;
        options.assertAlias(this.alias);
    }

    ensure(): Promise<string> {
        this.pending ??= this.prepare().finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }

    /** Resolve and validate an existing room without creating a chat. */
    async find(): Promise<string | undefined> {
        await this.intent.enableEncryption();
        const client = this.intent.underlyingClient;
        let room: string;
        try { room = await client.resolveRoom(this.alias); }
        catch (error) {
            if (errorCode(error) === 'M_NOT_FOUND') return undefined;
            throw error;
        }
        this.validateRoom(room);
        assertProvisionedManagementRoomState(await client.getRoomState(room), this.identity);
        return room;
    }

    /** Called before every command, even after successful provisioning. */
    async authorize(room: string): Promise<void> {
        this.validateRoom(room);
        assertManagementRoomState(
            await this.intent.underlyingClient.getRoomState(room),
            this.identity,
        );
    }

    private validateRoom(room: string): void {
        if (typeof room !== 'string' || !/^![^\s]+:[^\s]+$/.test(room))
            throw new Error('Invalid management room');
    }

    private async prepare(): Promise<string> {
        await this.intent.enableEncryption();
        const client = this.intent.underlyingClient;
        let room: string;
        try {
            room = await client.resolveRoom(this.alias);
        } catch (error) {
            if (errorCode(error) !== 'M_NOT_FOUND') throw error;
            try {
                room = await client.createRoom({
                    visibility: 'private',
                    preset: 'private_chat',
                    room_alias_name: this.localpart,
                    name: 'Threema bridge',
                    invite: [this.identity.owner],
                    ...{'com.beeper.auto_join_invites': true},
                    initial_state: managementRoomState(this.identity),
                });
            } catch (error) {
                if (errorCode(error) !== 'M_ROOM_IN_USE') throw error;
                room = await client.resolveRoom(this.alias);
            }
        }
        this.validateRoom(room);
        assertProvisionedManagementRoomState(await client.getRoomState(room), this.identity);
        return room;
    }
}
