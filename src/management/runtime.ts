import {ManagementRoom} from './room.ts';
import {ManagementWorker} from './worker.ts';
import {ManagementActions} from './actions.ts';
import {StartDm} from './start-dm.ts';
import {PortalManager} from '../matrix/portals.ts';
import {GhostManager} from '../matrix/ghosts.ts';
import {EncryptedSender} from '../matrix/encrypted-sender.ts';
import type {ProfileRuntimeOptions, ProfileRuntime} from '../service/profile-runtime.ts';
import type {BackendController} from '../threema/backend-controller.ts';

export function managementRuntime(
    options: ProfileRuntimeOptions & {
        backend: Pick<BackendController, 'ensureContact' | 'directory'>;
        assertPortalAlias: (alias: string) => void;
    },
    runtime: Pick<ProfileRuntime, 'status' | 'resync'>,
    probes: {
        doctor: ConstructorParameters<typeof ManagementActions>[0]['doctor'];
        version: ConstructorParameters<typeof ManagementActions>[0]['version'];
        registerRoom: (room: string) => Promise<void>;
        /** Notices provision the room; command polling must not create an empty chat. */
        existingOnly?: boolean;
    },
) {
    const room = new ManagementRoom(options.bot, {
        ...options,
        namespace: options.namespace ?? 'threema',
        assertAlias: options.assertPortalAlias,
    });
    const portals = new PortalManager(options.bot, options.portals, options);
    const ghosts = new GhostManager(
        options.portals,
        options.profile,
        options.domain,
        options.bot,
        options.getIntent,
        options.namespace,
    );
    const dm = new StartDm(options.backend, portals, ghosts);
    const sender = new EncryptedSender(options.bot, options.portals);
    const ready = () => runtime.status.state === 'running' && options.matrixReady();
    const actions = new ManagementActions({
        status: () => ({
            ...runtime.status,
            mediaQueues: options.outbox.media.pendingCounts(options.profile),
        }),
        directory: () => options.backend.directory(),
        resync: () => runtime.resync(),
        ...probes,
        pm: async (identity) => {
            const result = await dm.open(identity);
            runtime.resync();
            return result.room;
        },
    });
    let worker: ManagementWorker | undefined;
    let nextLookup = 0;
    return {
        async drain(limit = 100): Promise<number> {
            if (!ready()) return 0;
            if (!worker) {
                if (probes.existingOnly && Date.now() < nextLookup) return 0;
                nextLookup = Date.now() + 60_000;
                const id = probes.existingOnly ? await room.find() : await room.ensure();
                if (!id) return 0;
                await probes.registerRoom(id);
                await room.authorize(id);
                worker = new ManagementWorker({
                    inbox: options.inbox,
                    owner: options.owner,
                    room: id,
                    ready,
                    authorize: () => room.authorize(id),
                    execute: (command, eventId) => actions.execute(command, eventId),
                    send: (transaction, target, content) =>
                        sender.send(transaction, target, 'm.room.message', content),
                });
            }
            if (!ready()) return 0;
            return worker.drain(limit);
        },
    };
}
