import {joinOwnerPortal} from '../matrix/owner-room-join.ts';
import {useCurrentRoomMembers} from '../matrix/current-members.ts';
import {randomUUID} from 'node:crypto';
import {prepareOwnerEncryption} from '../matrix/owner-encryption.ts';
import {recoverOwnerSession} from '../matrix/owner-session.ts';
import {createOwnerBridgeIntent} from '../matrix/owner-bridge-intent.ts';
import type {EncryptedIntent} from '../matrix/encrypted-sender.ts';
import {DispatchGuard} from '../outbox/dispatch-guard.ts';
import {RoomStateRouter} from './room-state-router.ts';
import {createOriginalEventLoader} from '../matrix/original-event.ts';
import {assertProvisionedManagementRoomState} from '../management/room-policy.ts';
import {remoteGhostIdentity} from '../matrix/ghosts.ts';
import {Bridge} from '../../.local/sources/matrix-appservice-bridge/lib/index.js';
import {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {ProtectedAppserviceStorage} from '../matrix/appservice-storage.ts';
import {
    processNativeTransaction,
    type NativeTransaction,
} from '../matrix/native-transaction.ts';
import type {BridgeIntent} from '../matrix/journal-sink.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {TransactionDecoder} from '../matrix/transaction-worker.ts';
import type {parseRegistration} from './registration.ts';

export interface MatrixSession {
    bot: BridgeIntent;
    getIntent(userId: string): BridgeIntent;
    joinOwnerRoom?(room: string): Promise<void>;
    ownerIntent(): Promise<Pick<BridgeIntent, 'userId' | 'underlyingClient' | 'enableEncryption'>>;
    ownerBridgeIntent(): Promise<EncryptedIntent>;
    sendOwnerReadReceipt?(room: string, event: string): Promise<void>;
    decode: TransactionDecoder;
    handleState(event: import('../matrix/transaction-inbox.ts').InboxEvent): Promise<boolean>;
    ready(): boolean;
    originalEvents(options: {
        owner: string;
        authorize: (room: string) => Promise<void>;
        signal?: AbortSignal;
    }): ReturnType<typeof createOriginalEventLoader>;
    registerManagementRoom(room: string, owner: string): Promise<void>;
    close(): Promise<void>;
}
/** Native clients are explicit and profile-scoped; inbound transactions never create identities. */
export async function openMatrixSession(
    options: ReturnType<typeof parseRegistration> & {
        profile: string;
        namespace?: string;
        homeserver: string;
        directory: string;
        key: Buffer;
        portals: PortalStore;
        owner?: string;
    },
): Promise<MatrixSession> {
    if (
        options.owner !== undefined &&
        (!/^@[^\s:]+:[^\s]+$/.test(options.owner) ||
            options.owner === options.botUserId ||
            remoteGhostIdentity(
                options.profile,
                options.owner,
                options.domain,
                options.namespace,
            ) !== undefined ||
            options.registration.isUserMatch(options.owner, true))
    )
        throw new Error('Invalid Matrix owner capability');
    const storage = new ProtectedAppserviceStorage(options.directory, options.key);
    const bridge = new Bridge({
        domain: options.domain,
        homeserverUrl: options.homeserver,
        registration: options.registration,
        disableStores: true,
        logRequestOutcome: false,
        controller: {onEvent: () => undefined},
        nativeEncryption: {
            storage,
            cryptoStorage: {storageForUser: (id) => storage.cryptoForUser(id)},
        },
    });
    const intents = new Map<string, BridgeIntent>();
    const clients = new Map<string, MatrixClient>();
    const enabling = new Set<Promise<void>>();
    const retrievals = new Set<Promise<unknown>>();
    const shutdown = new AbortController();
    let managementRoom: string | undefined;
    const ownedRoom = (room: string) =>
        room === managementRoom || options.portals.portalForRoom(room)?.profile === options.profile;
    const roomStates = new RoomStateRouter(options.botUserId, ownedRoom);
    let closed = false,
        closing: Promise<void> | undefined;
    function allowed(userId: string): boolean {
        if (userId === options.botUserId) return true;
        return (
            remoteGhostIdentity(options.profile, userId, options.domain, options.namespace) !==
            undefined
        );
    }
    function getIntent(userId: string): BridgeIntent {
        if (closed || !allowed(userId))
            throw new Error('Matrix intent is outside the active profile');
        if (userId !== options.botUserId && !options.registration.isUserMatch(userId, true))
            throw new Error('Matrix ghost is not exclusively registered');
        const cached = intents.get(userId);
        if (cached) return cached;
        const intent = bridge.getIntent(userId).botSdkIntent;
        // A device login is needed for crypto, but Hungryserv associates new rooms with
        // an appservice only when creation itself uses the registration token.
        const appserviceClient = new MatrixClient(
            options.homeserver,
            options.registration.getOutput().as_token,
        );
        appserviceClient.impersonateUserId(userId);
        let deviceOpening: Promise<string> | undefined;
        const device = (): Promise<string> =>
            (deviceOpening ??= (async () => {
                const clientStore = storage.storageForUser(userId);
                const existing = await storage.cryptoForUser(userId).getDeviceId();
                const saved = await clientStore.readValue('bridgeDevice');
                if (saved && existing && saved !== existing)
                    throw new Error('Matrix device identity conflict');
                const id = existing || saved || `THREEMA_${randomUUID()}`;
                if (!saved) await clientStore.storeValue('bridgeDevice', id);
                return id;
            })());
        const exposed: BridgeIntent = {
            userId,
            get underlyingClient() {
                return intent.underlyingClient;
            },
            ensureRegistered: async () => {
                if (closed) throw new Error('Matrix session closed');
                await intent.ensureRegistered();
            },
            enableEncryption: async () => {
                if (closed) throw new Error('Matrix session closed');
                const task = device()
                    .then((id) => intent.enableEncryption(id))
                    .then(async () => {
                        const client = intent.underlyingClient;
                        useCurrentRoomMembers(client);
                        client.createRoom = async (request) => {
                            if (closed) throw new Error('Matrix session closed');
                            return appserviceClient.createRoom(request);
                        };
                        if (closed) {
                            client.crypto.close();
                            throw new Error('Matrix session closed');
                        }
                        clients.set(userId, client);
                        if (!roomStates.has(userId)) await roomStates.register(userId, client);
                    });
                enabling.add(task);
                try {
                    await task;
                } finally {
                    enabling.delete(task);
                }
            },
            joinRoom: async (room) => {
                if (closed) throw new Error('Matrix session closed');
                const result = await intent.joinRoom(room);
                roomStates.joined(userId, result);
                return result;
            },
            leaveRoom: async (room) => {
                if (closed) throw new Error('Matrix session closed');
                await intent.leaveRoom(room);
                roomStates.left(userId, room);
            },
        };
        intents.set(userId, exposed);
        return exposed;
    }
    let ownerOpening: ReturnType<MatrixSession['ownerIntent']> | undefined;
    function ownerIntent(): ReturnType<MatrixSession['ownerIntent']> {
        if (closed || !options.owner)
            return Promise.reject(new Error('Matrix owner capability unavailable'));
        ownerOpening ??= (async () => {
            const owner = options.owner!;
            const intent = bridge.getIntent(owner).botSdkIntent;
            const initialize = (async () => {
                try {
                    await prepareOwnerEncryption({
                        owner,
                        storage,
                        intent,
                        recoverSession: (device) =>
                            recoverOwnerSession({
                                owner,
                                device,
                                storage: storage.storageForUser(owner),
                                whoami: (token) => {
                                    const client = new MatrixClient(options.homeserver, token);
                                    client.impersonateUserId(owner);
                                    return client.getWhoAmI();
                                },
                                login: (device) =>
                                    intent.underlyingClient.doRequest(
                                        'POST',
                                        '/_matrix/client/v3/login',
                                        {},
                                        {
                                            type: 'm.login.application_service',
                                            device_id: device,
                                            identifier: {type: 'm.id.user', user: owner},
                                        },
                                    ),
                            }),
                    });
                    if (closed) throw new Error('Matrix session closed');
                    const client = intent.underlyingClient;
                    // Hungryserv cannot enumerate the real owner's global joined rooms
                    // using a local bridge-device token. Restore only verified portals.
                    client.getJoinedRooms = async () => {
                        const bot = getIntent(options.botUserId).underlyingClient;
                        const rooms = (await bot.getJoinedRooms()).filter(ownedRoom);
                        const joined: string[] = [];
                        for (const room of rooms) {
                            const membership = await bot.getRoomStateEvent(
                                room,
                                'm.room.member',
                                owner,
                            );
                            if (membership.membership === 'join') joined.push(room);
                        }
                        return joined;
                    };
                    const stateReader = (room: string) => {
                        if (closed || !ownedRoom(room))
                            throw new Error('Owner room state is outside the active profile');
                        return getIntent(options.botUserId).underlyingClient;
                    };
                    client.getRoomState = (room) => stateReader(room).getRoomState(room);
                    client.getRoomStateEvent = (room, type, stateKey) =>
                        stateReader(room).getRoomStateEvent(room, type, stateKey);
                    client.getRoomStateEventContent = (room, type, stateKey) =>
                        stateReader(room).getRoomStateEventContent(room, type, stateKey);
                    useCurrentRoomMembers(client);
                    await roomStates.register(owner, client);
                    if (closed) throw new Error('Matrix session closed');
                    clients.set(owner, client);
                } catch (error) {
                    intent.underlyingClient.crypto?.close();
                    throw new Error('Matrix owner identity initialization failed', {cause: error});
                }
            })();
            enabling.add(initialize);
            try {
                await initialize;
            } finally {
                enabling.delete(initialize);
            }
            return {
                userId: owner,
                get underlyingClient() {
                    if (closed) throw new Error('Matrix session closed');
                    return intent.underlyingClient;
                },
                enableEncryption: async () => {
                    if (closed || !intent.underlyingClient.crypto.isReady)
                        throw new Error('Matrix owner crypto unavailable');
                },
            };
        })();
        return ownerOpening;
    }
    function close(): Promise<void> {
        if (closing) return closing;
        closed = true;
        shutdown.abort();
        closing = (async () => {
            await Promise.allSettled([...retrievals]);
            await Promise.allSettled([...enabling]);
            let failed = false;
            for (const client of clients.values()) {
                try {
                    client.crypto.close();
                } catch {
                    failed = true;
                }
            }
            clients.clear();
            roomStates.clear();
            intents.clear();
            try {
                await bridge.close();
            } catch {
                failed = true;
            }
            try {
                storage.close();
            } catch {
                failed = true;
            }
            if (failed) throw new Error('Matrix session shutdown failed');
        })();
        return closing;
    }
    try {
        await bridge.initialise();
        const bot = getIntent(options.botUserId);
        await bot.enableEncryption();
        let ownerBridgeOpening: Promise<EncryptedIntent> | undefined;
        return {
            bot,
            getIntent,
            ownerIntent,
            ownerBridgeIntent: () => {
                if (closed || !options.owner) return Promise.reject(new Error('Owner unavailable'));
                const owner = options.owner;
                const client = new MatrixClient(
                    options.homeserver,
                    options.registration.getOutput().as_token,
                );
                client.impersonateUserId(owner);
                return (ownerBridgeOpening ??= createOwnerBridgeIntent({
                    owner,
                    bot,
                    ownerClient: client,
                    assertOpen: () => {
                        if (closed) throw new Error('Matrix session closed');
                    },
                    authorize: async (room) => {
                        const portal = options.portals.portalForRoom(room);
                        if (!portal || portal.profile !== options.profile)
                            throw new Error('Owner portal unavailable');
                        await new DispatchGuard({
                            profile: options.profile,
                            owner,
                            portals: options.portals,
                            bot,
                        }).check({
                            profile: options.profile,
                            sender: owner,
                            roomId: room,
                            chatId: portal.chat,
                        });
                    },
                }));
            },
            sendOwnerReadReceipt: async (room, event) => {
                const owner = options.owner;
                const portal = options.portals.portalForRoom(room);
                if (
                    closed ||
                    !owner ||
                    portal?.profile !== options.profile ||
                    !/^\$[^\s]{1,1024}$/.test(event)
                )
                    throw Error('Owner receipt target unavailable');
                await new DispatchGuard({
                    profile: options.profile,
                    owner,
                    portals: options.portals,
                    bot,
                }).check({
                    profile: options.profile,
                    sender: owner,
                    roomId: room,
                    chatId: portal.chat,
                });
                if (closed) throw Error('Matrix session closed');
                const client = new MatrixClient(
                    options.homeserver,
                    options.registration.getOutput().as_token,
                );
                client.impersonateUserId(owner);
                await client.sendReadReceipt(room, event);
            },
            joinOwnerRoom: async (room) => {
                if (
                    closed ||
                    !options.owner ||
                    options.portals.portalForRoom(room)?.profile !== options.profile
                )
                    throw new Error('Owner join is outside the active profile');
                const ownerClient = new MatrixClient(
                    options.homeserver,
                    options.registration.getOutput().as_token,
                );
                ownerClient.impersonateUserId(options.owner);
                await joinOwnerPortal({
                    room,
                    profile: options.profile,
                    owner: options.owner,
                    botId: options.botUserId,
                    active: () => !closed,
                    mappedChat: () => {
                        const portal = options.portals.portalForRoom(room);
                        return portal?.profile === options.profile ? portal.chat : undefined;
                    },
                    bot: bot.underlyingClient,
                    ownerClient,
                });
            },
            originalEvents: ({owner, authorize, signal}) => {
                const client = clients.get(options.botUserId);
                if (closed || !client?.crypto.isReady)
                    throw new Error('Matrix bot crypto is not ready');
                const assertPortal = (room: string) => {
                    if (closed || options.portals.portalForRoom(room)?.profile !== options.profile)
                        throw new Error('Original event is outside the active profile');
                };
                const load = createOriginalEventLoader({
                    client,
                    userId: options.botUserId,
                    owner,
                    signal: signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal,
                    authorize: async (room) => {
                        assertPortal(room);
                        await authorize(room);
                        assertPortal(room);
                    },
                });
                return async (event, room) => {
                    const task = load(event, room);
                    retrievals.add(task);
                    try {
                        return await task;
                    } finally {
                        retrievals.delete(task);
                    }
                };
            },
            registerManagementRoom: async (room, owner) => {
                if (
                    closed ||
                    !/^![^\s]+:[^\s]+$/.test(room) ||
                    (managementRoom && managementRoom !== room)
                )
                    throw new Error('Invalid management room registration');
                const client = clients.get(options.botUserId);
                if (!client?.crypto.isReady) throw new Error('Matrix bot crypto is not ready');
                assertProvisionedManagementRoomState(await client.getRoomState(room), {
                    profile: options.profile,
                    owner,
                    bot: options.botUserId,
                });
                await client.crypto.onRoomJoin(room);
                if (closed) throw new Error('Matrix session closed');
                managementRoom = room;
                roomStates.joined(options.botUserId, room);
            },
            handleState: async (event) => {
                if (closed) throw new Error('Matrix session closed');
                // Membership has additional portal/admin policy still handled separately.
                if (
                    event.state_key !== '' ||
                    !['m.room.encryption', 'm.room.history_visibility'].includes(event.type) ||
                    !ownedRoom(event.room_id)
                )
                    return false;
                await roomStates.apply(event);
                return true;
            },
            close,
            ready: () => !closed && clients.get(options.botUserId)?.crypto.isReady === true,
            decode: async (body, emit) => {
                if (closed) throw new Error('Matrix session closed');
                const transaction = body as NativeTransaction;
                // Suppress only exact persisted ciphertext, including sends whose HTTP reply
                // was lost. Caller-controlled plaintext markers never authorize suppression.
                const filtered = {
                    ...transaction,
                    events: transaction.events.filter(
                        (event) =>
                            !(
                                event.type === 'm.room.encrypted' &&
                                ownedRoom(event.room_id) &&
                                options.portals.isOwnEncryptedEvent(
                                    event.sender,
                                    event.room_id,
                                    event.content,
                                    event.event_id,
                                )
                            ),
                    ),
                };
                await processNativeTransaction(
                    filtered,
                    clients,
                    (room) => {
                        if (!ownedRoom(room))
                            throw new Error('Encrypted event is outside the active profile');
                        const client = clients.get(options.botUserId);
                        if (!client?.crypto.isReady)
                            throw new Error('Matrix bot crypto is not ready');
                        return client;
                    },
                    async (event) => {
                        await roomStates.apply(event);
                        await emit(event);
                    },
                );
            },
        };
    } catch (error) {
        await close();
        throw error;
    }
}
