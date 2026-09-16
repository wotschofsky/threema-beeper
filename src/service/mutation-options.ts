import {DispatchGuard} from '../outbox/dispatch-guard.ts';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {MatrixSession} from './matrix-session.ts';
import type {ProfileRuntimeOptions} from './profile-runtime.ts';

/** Connect original-event retrieval to the same fresh authorization as mutation dispatch. */
export function mutationOptions(options: {
    profile: string;
    owner: string;
    portals: PortalStore;
    matrix: Pick<MatrixSession, 'bot' | 'originalEvents'>;
}): NonNullable<ProfileRuntimeOptions['mutations']> {
    const guard = new DispatchGuard({...options, bot: options.matrix.bot});
    return {
        createOriginalLoader: (signal) =>
            options.matrix.originalEvents({
                owner: options.owner,
                signal,
                authorize: async (room) => {
                    const portal = options.portals.portalForRoom(room);
                    if (!portal || portal.profile !== options.profile)
                        throw new Error('Original event is outside the active profile');
                    await guard.check({
                        profile: options.profile,
                        sender: options.owner,
                        roomId: room,
                        chatId: portal.chat,
                    });
                },
            }),
    };
}
