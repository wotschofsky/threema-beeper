import {mutationOptions} from './mutation-options.ts';
import {join} from 'node:path';
import {ManagementRoom} from '../management/room.ts';
import {managementRuntime} from '../management/runtime.ts';
import {localDoctor} from './local-doctor.ts';
import {sourceVersion} from './version.ts';
import {EncryptedSender} from '../matrix/encrypted-sender.ts';
import {UpstreamNotices, readUpstreamState} from '../operations/upstream-notices.ts';
import {BackupNotices} from '../operations/backup-notices.ts';
import {readBackupStatus} from '../backup/status.ts';
import {SecurityNotices} from '../operations/security-notices.ts';
import {readSecurityScanState} from '../operations/security-scan-store.ts';
import {ReconnectNotices} from '../operations/reconnect-notices.ts';
import {readReconnectState, writeReconnectState} from '../operations/reconnect-store.ts';
import {ConnectionIssueJournal, ConnectionIssueNotices} from '../operations/connection-issues.ts';
import {DiskNotices, diskCapacity, readDiskState, writeDiskState} from '../operations/disk-notices.ts';
import {createOwnerMediaRenderer} from '../matrix/owner-media-content.ts';
import {createServiceMedia} from './media.ts';
import {bridgeStatus} from './bridge-status.ts';
import {assertPortalAlias} from './portal-alias.ts';
import {prepareProxy} from './proxy.ts';
import type {ProfileRuntimeOptions} from './profile-runtime.ts';
import type {ProcessSupervisor} from './process-supervisor.ts';
import type {Server} from 'node:http';
import {createTransactionServer} from '../matrix/transaction-server.ts';
import {openSavedProfile} from '../threema/saved-profile.ts';
import {openMatrixSession, type MatrixSession} from './matrix-session.ts';
import {ProfileRuntime} from './profile-runtime.ts';
import {readRegistration} from './registration.ts';
import {openBridgeResources, type BridgeResources} from './resources.ts';
import type {ServiceConfig} from './config.ts';

export interface RunningService {
    status(): ProfileRuntime['status'] & {proxy: string};
    close(): Promise<void>;
    resync(): boolean;
}
/** Assemble one service instance. Config/registration values and raw SDK errors must never be logged. */
export async function startService(
    config: ServiceConfig,
    signal?: AbortSignal,
): Promise<RunningService> {
    const lifetime = new AbortController();
    const startup = new AbortController();
    const abort = () => {
        startup.abort();
        lifetime.abort();
    };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const timer = setTimeout(() => startup.abort(), config.startupTimeoutMs);
    const openingSignal = AbortSignal.any([startup.signal, lifetime.signal]);
    let resources: BridgeResources | undefined;
    let profile: Awaited<ReturnType<typeof openSavedProfile>> | undefined;
    let matrix: MatrixSession | undefined;
    let server: Server | undefined;
    let runtime: ProfileRuntime | undefined;
    let proxy: ProcessSupervisor | undefined;
    let connectionIssues: ConnectionIssueJournal | undefined;
    const proxyReady = () => !config.proxy || proxy?.state === 'running';
    let closing: Promise<void> | undefined;
    function close(): Promise<void> {
        if (closing) return closing;
        signal?.removeEventListener('abort', abort);
        lifetime.signal.removeEventListener('abort', stopped);
        abort();
        clearTimeout(timer);
        closing = (async () => {
            let failed = false;
            const runtimeStop = runtime?.stop().catch(() => {
                failed = true;
            });
            const proxyStop = proxy?.stop().catch(() => {
                failed = true;
            });
            await proxyStop;
            if (server?.listening) {
                try {
                    await new Promise<void>((resolve, reject) => {
                        server!.close((error) => (error ? reject(error) : resolve()));
                        server!.closeAllConnections();
                    });
                } catch {
                    failed = true;
                }
            }
            try {
                await runtimeStop;
            } catch {
                failed = true;
            }
            try {
                await profile?.close();
            } catch {
                failed = true;
            }
            try {
                await matrix?.close();
            } catch {
                failed = true;
            }
            try {
                await connectionIssues?.flush();
            } catch {
                failed = true;
            }
            try {
                resources?.close();
            } catch {
                failed = true;
            }
            if (failed) throw new Error('Service shutdown failed');
        })();
        return closing;
    }
    const stopped = () => {
        void close().catch(() => {});
    };
    try {
        openingSignal.throwIfAborted();
        const registration = await readRegistration(config);
        openingSignal.throwIfAborted();
        if (config.proxy) proxy = await prepareProxy(config, openingSignal);
        resources = openBridgeResources(config);
        connectionIssues = await ConnectionIssueJournal.load(join(config.dataDirectory, 'maintenance/connection-issues'));
        profile = await openSavedProfile({
            profileDirectory: config.profileDirectory,
            secretFile: config.passwordFile,
            wasmFile: config.wasmFile,
            signal: openingSignal,
            onConnectionIssue: issue => connectionIssues!.record(issue),
        });
        if (profile.identity !== config.identity)
            throw new Error('Configured profile identity does not match');
        openingSignal.throwIfAborted();
        matrix = await openMatrixSession({
            ...registration,
            owner: config.owner,
            profile: config.identity,
            namespace: config.matrix.namespace,
            homeserver: config.matrix.homeserver,
            directory: resources.matrixDirectory,
            key: resources.matrixKey,
            portals: resources.portals,
        });
        openingSignal.throwIfAborted();
        await matrix.ownerBridgeIntent();
        openingSignal.throwIfAborted();
        const media = config.features?.media
            ? await createServiceMedia(
                  config,
                  profile.backend,
                  matrix,
                  resources.portals,
                  lifetime.signal,
                  registration.registration.getAppServiceToken()!,
              )
            : {};
        openingSignal.throwIfAborted();
        const mutation = config.features?.mutations
            ? mutationOptions({
                  profile: config.identity,
                  owner: config.owner,
                  portals: resources.portals,
                  matrix,
              })
            : undefined;
        const runtimeOptions = {
            mutations: mutation,
            ...media,
            ...(mutation && config.features?.media
                ? {
                      renderOwnerMedia: createOwnerMediaRenderer({
                          profile: config.identity,
                          owner: config.owner,
                          portals: resources.portals,
                          original: mutation.createOriginalLoader(lifetime.signal),
                      }),
                  }
                : {}),
            profile: config.identity,
            namespace: config.matrix.namespace,
            owner: config.owner,
            domain: registration.domain,
            backend: profile.backend,
            journal: resources.journal,
            inbox: resources.inbox,
            outbox: resources.outbox,
            portals: resources.portals,
            bot: matrix.bot,
            getIntent: matrix.getIntent,
            getOwnerIntent: matrix.ownerBridgeIntent,
            joinOwnerRoom: matrix.joinOwnerRoom,
            sendOwnerReadReceipt: matrix.sendOwnerReadReceipt,
            assertPortalAlias: (alias: string) => {
                assertPortalAlias(
                    registration.registration,
                    config.matrix.namespace,
                    registration.domain,
                    alias,
                );
            },
            decode: matrix.decode,
            handleState: matrix.handleState,
            matrixReady: matrix.ready,
            textOnly: true,
            includeGroups: config.features?.groups === true,
            includeMedia: config.features?.media === true,
            includeReactions: config.features?.reactions === true,
            includeMutations: config.features?.mutations === true,
            includeReceipts: config.features?.receipts === true,
            protocolAvatar: config.matrix.protocolAvatar,
            sync: config.sync,
        } satisfies ProfileRuntimeOptions;
        const managementRoom = new ManagementRoom(matrix.bot, {
            profile: config.identity, owner: config.owner, domain: registration.domain,
            namespace: config.matrix.namespace, assertAlias: runtimeOptions.assertPortalAlias,
        });
        const maintenanceSender = new EncryptedSender(matrix.bot, resources.portals);
        const session = matrix;
        const portalStore = resources.portals;
        const reconnectDirectory = join(config.dataDirectory, 'maintenance/reconnect');
        const initialReconnect = await readReconnectState(reconnectDirectory);
        const diskDirectory = join(config.dataDirectory, 'maintenance/disk');
        const initialDisk = await readDiskState(diskDirectory);
        let reconnectNotices: ReconnectNotices;
        runtime = new ProfileRuntime({...runtimeOptions,
            connectionChanged: connected => {
                reconnectNotices.observe(connected);
                if (connected) connectionIssues!.recovered();
            },
            management: current => {
            const delivery = {
                owner: config.owner,
                ready: () => current.status.state === 'running' && session.ready(),
                delivered: (id: string) => Boolean(portalStore.operation(id)?.event),
                authorize: async () => {
                    if (!session.joinOwnerRoom) throw new Error('Management automatic join unavailable');
                    const room = await managementRoom.ensure();
                    await session.joinOwnerRoom(room);
                    await managementRoom.authorize(room);
                    await session.registerManagementRoom(room, config.owner);
                    return room;
                },
                send: (id: string, room: string, content: Record<string, unknown>) =>
                    maintenanceSender.send(id, room, 'm.room.message', content),
            };
            const notices = new UpstreamNotices({
                ...delivery,
                load: () => readUpstreamState(join(config.dataDirectory, 'maintenance/upstream/state.json')),
            });
            const backupNotices = new BackupNotices({
                ...delivery,
                load: () => readBackupStatus(join(config.dataDirectory, 'maintenance/backup')),
            });
            const securityNotices = new SecurityNotices({
                ...delivery,
                load: () => readSecurityScanState(join(config.dataDirectory, 'maintenance/security')),
            });
            reconnectNotices = new ReconnectNotices({...delivery, initial: initialReconnect,
                now: Date.now, persist: state => writeReconnectState(reconnectDirectory, state)});
            const compatibilityNotices = new ConnectionIssueNotices({...delivery, journal: connectionIssues!});
            const diskNotices = new DiskNotices({...delivery, initial: initialDisk, now: Date.now,
                sample: () => diskCapacity(config.dataDirectory), persist: state => writeDiskState(diskDirectory, state)});
            const commands = managementRuntime(runtimeOptions, current, {
                existingOnly: true,
                doctor: () => localDoctor(config),
                version: sourceVersion,
                registerRoom: async room => {
                    if (!session.joinOwnerRoom) throw new Error('Management automatic join unavailable');
                    await session.joinOwnerRoom(room);
                    await session.registerManagementRoom(room, config.owner);
                },
            });
            return {async drain(limit: number) {
                // Finish commands first so a failed monitor read cannot strand requests.
                const completed = await commands.drain(limit);
                // An unavailable upstream check must not prevent backup warnings.
                const results: PromiseSettledResult<number>[] = [];
                for (const notifier of [notices, backupNotices, securityNotices, reconnectNotices, compatibilityNotices, diskNotices]) {
                    results.push(...await Promise.allSettled([notifier.drain()]));
                }
                const failure = results.find(result => result.status === 'rejected');
                if (failure?.status === 'rejected') throw failure.reason;
                return completed + results.reduce((sum, result) => sum +
                    (result.status === 'fulfilled' ? result.value : 0), 0);
            }};
        }});
        const homeserverToken = registration.registration.getHomeserverToken();
        if (!homeserverToken) throw new Error('Missing homeserver token');
        const health = () => {
            const live = closing === undefined && !lifetime.signal.aborted;
            let ready = false;
            try {
                ready =
                    live &&
                    proxyReady() &&
                    runtime?.status.ready === true &&
                    resources?.checkHealth() === true;
            } catch {
                /* Readiness must fail without affecting process liveness. */
            }
            return {live, ready};
        };
        server = createTransactionServer(
            resources.inbox,
            homeserverToken,
            1024 * 1024,
            health,
            () => ({
                ...health(),
                syncLive: runtime?.status.synchronization === 'live',
                ...(proxy ? {proxyUp: proxy.state === 'running'} : {}),
                uptimeSeconds: process.uptime(),
                residentBytes: process.memoryUsage.rss(),
                reactionQueues: resources!.outbox.reactions.pendingCounts(config.identity),
                mediaQueues: resources!.outbox.media.pendingCounts(config.identity),
                queues: {
                    journal: resources!.journal.pendingCount(),
                    ...resources!.inbox.pendingCounts(),
                    ...resources!.outbox.pendingCounts(config.identity),
                },
            }),
            (body) => runtime?.receiveEphemeral(body),
            () =>
                bridgeStatus(config.owner, config.identity, {
                    ...health(),
                    syncLive: runtime?.status.synchronization === 'live',
                }),
            (action) => {
                const retried =
                    action === 'retry' ? resources!.outbox.retryPrepared(config.identity) : 0;
                const resync = action !== 'status' ? runtime?.resync() === true : false;
                return {
                    ready: health().ready,
                    retried,
                    resync,
                    explanation:
                        'Only definitely unsent work is retried. Uncertain sends stay held; check Threema on your phone before sending again.',
                    items: resources!.outbox
                        .recoveryItems(config.identity)
                        .map(({id, kind, state, failures}) => ({
                            id,
                            kind,
                            state,
                            failures,
                            canRetry: state === 'PREPARED',
                        })),
                };
            },
        );
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error) => {
                server!.off('listening', bound);
                reject(error);
            };
            const bound = () => {
                server!.off('error', failed);
                resolve();
            };
            server!.once('error', failed);
            server!.once('listening', bound);
            server!.listen(config.matrix.port, config.matrix.listen);
        });
        openingSignal.throwIfAborted();
        proxy?.start();
        await runtime.start();
        openingSignal.throwIfAborted();
        clearTimeout(timer);
        lifetime.signal.addEventListener('abort', stopped, {once: true});
        return {
            resync: () => closing === undefined && runtime!.resync(),
            status: () => ({
                ...runtime!.status,
                ready: runtime!.status.ready && proxyReady(),
                proxy: proxy?.state ?? 'external',
            }),
            close,
        };
    } catch (error) {
        await close();
        throw new Error(
            'Service startup failed; verify configuration, registration and existing profile',
            {cause: error},
        );
    }
}
