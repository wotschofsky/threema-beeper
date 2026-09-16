import type {BackendController} from '../threema/backend-controller.ts';
import type {PortalManager} from '../matrix/portals.ts';
import type {GhostManager} from '../matrix/ghosts.ts';

/** Every step recovers through the upstream identity, stable portal alias, or ghost mapping. */
export class StartDm {
    private readonly backend: Pick<BackendController, 'ensureContact'>;
    private readonly portals: Pick<PortalManager, 'ensure'>;
    private readonly ghosts: Pick<GhostManager, 'ensure' | 'reconcile'>;
    constructor(
        backend: StartDm['backend'],
        portals: StartDm['portals'],
        ghosts: StartDm['ghosts'],
    ) {
        this.backend = backend;
        this.portals = portals;
        this.ghosts = ghosts;
    }
    async open(input: string): Promise<{room: string; ghost: string}> {
        if (!/^[A-Za-z0-9*][A-Za-z0-9]{7}$/.test(input))
            throw new Error('Invalid contact identity');
        const identity = input.toUpperCase();
        const contact = await this.backend.ensureContact(identity);
        if (contact.identity !== identity) throw new Error('Contact identity mismatch');
        const chat = `c:${identity}`;
        const room = await this.portals.ensure({
            chatId: chat,
            name: contact.displayName,
            unreadCount: 0,
            archived: false,
            pinned: false,
        });
        const ghost = await this.ghosts.ensure(identity, contact.displayName);
        await this.ghosts.reconcile(room, chat, [identity]);
        return {room, ghost: ghost.userId};
    }
}
