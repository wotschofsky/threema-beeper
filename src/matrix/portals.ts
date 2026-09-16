import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {PortalStore} from './portal-store.ts';
import {parseConversations, type ConversationSummary} from '../threema/conversations.ts';

interface PortalIntent {
    userId: string;
    enableEncryption(): Promise<void>;
    underlyingClient: Pick<
        MatrixClient,
        'resolveRoom' | 'createRoom' | 'getRoomState' | 'sendStateEvent'
    >;
}
const markerKey = 'threema://bridge';
function errorCode(error: unknown): unknown {
    return error && typeof error === 'object' ? (error as {errcode?: unknown}).errcode : undefined;
}

/** Creates private encrypted portals and recovers a create-before-mapping crash through a stable alias. */
export class PortalManager {
    private readonly intent: PortalIntent;
    private readonly store: PortalStore;
    private readonly owner: string;
    private readonly profile: string;
    private readonly domain: string;
    private readonly namespace: string;
    private readonly protocolAvatar?: string;
    private readonly assertPortalAlias?: (alias: string) => void;
    private readonly pending = new Map<string, Promise<string>>();
    constructor(
        intent: PortalIntent,
        store: PortalStore,
        options: {
            namespace?: string;
            protocolAvatar?: string;
            owner: string;
            profile: string;
            domain: string;
            assertPortalAlias?: (alias: string) => void;
        },
    ) {
        if (
            !/^@[\x21-\x7e]+:[^\s]+$/.test(options.owner) ||
            !/^[A-Z0-9*][A-Z0-9]{7}$/.test(options.profile) ||
            !/^[A-Za-z0-9.:-]+$/.test(options.domain)
        )
            throw new Error('Invalid portal configuration');
        this.protocolAvatar = options.protocolAvatar;
        this.intent = intent;
        this.store = store;
        this.owner = options.owner;
        this.profile = options.profile;
        this.domain = options.domain;
        this.namespace = options.namespace ?? 'threema';
        if (!/^[a-z0-9-]{1,32}$/.test(this.namespace)) throw new Error('Invalid Matrix namespace');
        this.assertPortalAlias = options.assertPortalAlias;
    }
    ensure(chat: ConversationSummary): Promise<string> {
        const safe = parseConversations([chat])[0]!;
        let task = this.pending.get(safe.chatId);
        if (!task) {
            task = this.prepare(safe).finally(() => this.pending.delete(safe.chatId));
            this.pending.set(safe.chatId, task);
        }
        return task;
    }
    private async verify(roomId: string, chatId: string, unmapped: boolean): Promise<void> {
        if (!/^![^\s]+:[^\s]+$/.test(roomId)) throw new Error('Invalid portal room');
        const state = await this.intent.underlyingClient.getRoomState(roomId);
        const encryption = state.find(
            (event) => event.type === 'm.room.encryption' && event.state_key === '',
        );
        const marker = state.find(
            (event) => event.type === 'm.bridge' && event.state_key === markerKey,
        );
        if (
            encryption?.content?.algorithm !== 'm.megolm.v1.aes-sha2' ||
            marker?.sender !== this.intent.userId ||
            marker?.content?.creator !== this.owner ||
            (marker?.content?.network as {id?: unknown} | undefined)?.id !== this.profile ||
            (marker?.content?.channel as {id?: unknown} | undefined)?.id !== chatId
        )
            throw new Error('Portal encryption or ownership verification failed');
        const botMember = state.find(
            (event) => event.type === 'm.room.member' && event.state_key === this.intent.userId,
        );
        if (
            this.domain === 'beeper.local' &&
            botMember?.content?.membership === 'join' &&
            botMember.content['com.beeper.bridge.is_bridge_bot'] !== true
        ) {
            await this.intent.underlyingClient.sendStateEvent(
                roomId,
                'm.room.member',
                this.intent.userId,
                {...botMember.content, 'com.beeper.bridge.is_bridge_bot': true},
            );
        }
        const topic = state.find(
            (event) => event.type === 'm.room.topic' && event.state_key === '',
        );
        if (this.domain === 'beeper.local' && !topic)
            await this.intent.underlyingClient.sendStateEvent(roomId, 'm.room.topic', '', {
                topic: 'Polls, locations and calls are not supported in Beeper. Open Threema on your phone to use them. Incoming calls may only appear on your phone.',
            });
        const content = {
            ...marker.content,
            ...(this.domain === 'beeper.local'
                ? {
                      'com.beeper.bridge_name': this.namespace,
                      'com.beeper.self_hosted': true,
                  }
                : {}),
            channel: {
                ...(marker.content?.channel as Record<string, unknown>),
                'com.beeper.message_request': false,
            },
            ...(chatId.startsWith('c:')
                ? {'com.beeper.room_type': 'dm', 'com.beeper.room_type.v2': 'dm'}
                : {}),
            protocol: {
                ...(marker.content?.protocol as Record<string, unknown>),
                ...(this.protocolAvatar ? {avatar_url: this.protocolAvatar} : {}),
            },
            // Beeper renders account-network sidebar entries from network branding,
            // even when the protocol already carries the same name and avatar.
            network: {
                ...(marker.content?.network as Record<string, unknown>),
                displayname: 'Threema',
                ...(this.protocolAvatar ? {avatar_url: this.protocolAvatar} : {}),
            },
        };
        // Beeper and other clients still consume the original bridge-info event name.
        // Repair older portals only after verifying their ownership and encryption above.
        // Beeper does not process bridge-info side effects from createRoom.initial_state.
        // Publish once after creation/recovery; also repair already-mapped unrecognized rooms.
        const publish =
            unmapped ||
            (this.domain === 'beeper.local' && marker.content?.['com.beeper.self_hosted'] !== true);
        for (const type of ['m.bridge', 'uk.half-shot.bridge']) {
            const existing = state.find(
                (event) => event.type === type && event.state_key === markerKey,
            );
            if (publish || !isDeepStrictEqual(existing?.content, content)) {
                await this.intent.underlyingClient.sendStateEvent(roomId, type, markerKey, content);
            }
        }
    }
    private async prepare(chat: ConversationSummary): Promise<string> {
        const localpart =
            this.namespace +
            '_' +
            createHash('sha256')
                // Do not rediscover an unmapped room created with legacy device credentials.
                // Explicit existing mappings remain authoritative; new rooms use AS credentials.
                .update(`${this.profile}\0${chat.chatId}\0appservice-v1`)
                .digest('hex')
                .slice(0, 40);
        const alias = `#${localpart}:${this.domain}`;
        this.assertPortalAlias?.(alias);
        await this.intent.enableEncryption();
        const client = this.intent.underlyingClient;
        let room = this.store.get(this.profile, chat.chatId);
        if (!room) {
            try {
                room = await client.resolveRoom(alias);
            } catch (error) {
                if (errorCode(error) !== 'M_NOT_FOUND') throw error;
            }
            if (!room) {
                try {
                    room = await client.createRoom({
                        visibility: 'private',
                        preset: 'private_chat',
                        room_alias_name: localpart,
                        name: chat.name,
                        invite: [this.owner],
                        // Beeper joins the owner atomically when importing a conversation.
                        ...{'com.beeper.auto_join_invites': true},
                        initial_state: [
                            {
                                type: 'm.room.topic',
                                state_key: '',
                                content: {
                                    topic: 'Polls, locations and calls are not supported in Beeper. Open Threema on your phone to use them. Incoming calls may only appear on your phone.',
                                },
                            },
                            ...(this.domain === 'beeper.local'
                                ? [
                                      {
                                          type: 'm.room.member',
                                          state_key: this.intent.userId,
                                          content: {
                                              'membership': 'join',
                                              'com.beeper.bridge.is_bridge_bot': true,
                                          },
                                      },
                                  ]
                                : []),
                            {
                                type: 'm.room.encryption',
                                state_key: '',
                                content: {algorithm: 'm.megolm.v1.aes-sha2'},
                            },
                            {
                                type: 'm.bridge',
                                state_key: markerKey,
                                content: {
                                    ...(chat.chatId.startsWith('c:')
                                        ? {
                                              'com.beeper.room_type': 'dm',
                                              'com.beeper.room_type.v2': 'dm',
                                          }
                                        : {}),
                                    ...(this.domain === 'beeper.local'
                                        ? {
                                              'com.beeper.bridge_name': this.namespace,
                                              'com.beeper.self_hosted': true,
                                          }
                                        : {}),
                                    bridgebot: this.intent.userId,
                                    creator: this.owner,
                                    protocol: {
                                        id: 'threema',
                                        displayname: 'Threema',
                                        ...(this.protocolAvatar
                                            ? {avatar_url: this.protocolAvatar}
                                            : {}),
                                    },
                                    network: {
                                        id: this.profile,
                                        displayname: 'Threema',
                                        ...(this.protocolAvatar
                                            ? {avatar_url: this.protocolAvatar}
                                            : {}),
                                    },
                                    channel: {
                                        'id': chat.chatId,
                                        'displayname': chat.name,
                                        'com.beeper.message_request': false,
                                    },
                                },
                            },
                        ].flatMap((event) =>
                            event.type === 'm.bridge'
                                ? [event, {...event, type: 'uk.half-shot.bridge'}]
                                : [event],
                        ),
                    });
                } catch (error) {
                    if (errorCode(error) !== 'M_ROOM_IN_USE') throw error;
                    room = await client.resolveRoom(alias);
                }
            }
        }
        await this.verify(room, chat.chatId, !this.store.get(this.profile, chat.chatId));
        this.store.bind(this.profile, chat.chatId, room);
        return room;
    }
}
