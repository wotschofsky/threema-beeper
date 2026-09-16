import type {Intent} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/appservice/Intent.js';
import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {PortalStore} from './portal-store.ts';

export type GhostIntent = Pick<
    Intent,
    'userId' | 'ensureRegistered' | 'enableEncryption' | 'joinRoom' | 'leaveRoom'
> & {
    underlyingClient: Pick<MatrixClient, 'setDisplayName' | 'getUserProfile'>;
};
interface MembershipBot {
    userId: string;
    underlyingClient: Pick<MatrixClient, 'getRoomState' | 'inviteUser'>;
}
function identity(value: string): void {
    if (!/^[A-Z0-9*][A-Z0-9]{7}$/.test(value)) throw new Error('Invalid Threema identity');
}

/** Stable reversible localparts; scope ghosts to the profile, including gateway IDs starting with *. */
export function ghostUserId(
    profile: string,
    remote: string,
    domain: string,
    namespace = 'threema',
): string {
    if (!/^[a-z0-9-]{1,32}$/.test(namespace)) throw new Error('Invalid Matrix namespace');
    identity(profile);
    identity(remote);
    if (!/^[A-Za-z0-9.:-]+$/.test(domain)) throw new Error('Invalid Matrix domain');
    return `@${namespace}_${Buffer.from(profile).toString('hex')}_${Buffer.from(remote).toString('hex')}:${domain}`;
}

/** Decode only canonical identities in this profile and configured namespace. */
export function remoteGhostIdentity(
    profile: string,
    mxid: string,
    domain: string,
    namespace = 'threema',
): string | undefined {
    const prefix =
        ghostUserId(profile, profile, domain, namespace).split('_').slice(0, 2).join('_') + '_';
    const suffix = `:${domain}`;
    if (!mxid.startsWith(prefix) || !mxid.endsWith(suffix)) return undefined;
    const hex = mxid.slice(prefix.length, -suffix.length);
    if (!/^[0-9a-f]{16}$/.test(hex)) return undefined;
    const remote = Buffer.from(hex, 'hex').toString('utf8');
    if (!/^[A-Z0-9*][A-Z0-9]{7}$/.test(remote)) return undefined;
    return ghostUserId(profile, remote, domain, namespace) === mxid ? remote : undefined;
}

/** Serializes mutations per ghost and per room. Call with canonical, authoritative membership. */
export class GhostManager {
    private readonly store: PortalStore;
    private readonly profile: string;
    private readonly domain: string;
    private readonly namespace: string;
    private readonly getIntent: (mxid: string) => GhostIntent;
    private readonly bot: MembershipBot;
    private readonly users = new Map<string, Promise<unknown>>();
    private readonly rooms = new Map<string, Promise<unknown>>();
    constructor(
        store: PortalStore,
        profile: string,
        domain: string,
        bot: MembershipBot,
        getIntent: (mxid: string) => GhostIntent,
        namespace = 'threema',
    ) {
        ghostUserId(profile, profile, domain, namespace);
        this.store = store;
        this.profile = profile;
        this.domain = domain;
        this.namespace = namespace;
        this.bot = bot;
        this.getIntent = getIntent;
    }
    private queue<T>(
        map: Map<string, Promise<unknown>>,
        key: string,
        action: () => Promise<T>,
    ): Promise<T> {
        const task = (map.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
        map.set(key, task);
        void task
            .finally(() => {
                if (map.get(key) === task) map.delete(key);
            })
            .catch(() => {});
        return task;
    }
    ensure(remote: string, displayName?: string): Promise<GhostIntent> {
        const mxid = ghostUserId(this.profile, remote, this.domain, this.namespace);
        if (
            displayName !== undefined &&
            (typeof displayName !== 'string' || displayName.length > 16384)
        )
            throw new Error('Invalid ghost display name');
        return this.queue(this.users, mxid, async () => {
            const stored = this.store.ghost(this.profile, remote);
            if (stored && stored !== mxid) throw new Error('Ghost mapping conflict');
            const intent = this.getIntent(mxid);
            if (intent.userId !== mxid) throw new Error('Ghost intent identity mismatch');
            await intent.ensureRegistered();
            await intent.enableEncryption();
            this.store.bindGhost(this.profile, remote, mxid);
            if (displayName !== undefined) {
                const existing = await intent.underlyingClient.getUserProfile(mxid);
                if (existing.displayname !== displayName)
                    await intent.underlyingClient.setDisplayName(displayName);
            }
            return intent;
        });
    }
    reconcile(room: string, chat: string, members: readonly string[]): Promise<void> {
        if (members.length > 100000) throw new Error('Membership exceeds limits');
        const desired = new Map(
            members.map((remote) => [
                ghostUserId(this.profile, remote, this.domain, this.namespace),
                remote,
            ]),
        );
        return this.queue(this.rooms, room, async () => {
            if (this.store.get(this.profile, chat) !== room)
                throw new Error('Unknown portal membership target');
            const state = await this.bot.underlyingClient.getRoomState(room);
            const encryption = state.find(
                (event) => event.type === 'm.room.encryption' && event.state_key === '',
            );
            const marker = state.find(
                (event) => event.type === 'm.bridge' && event.state_key === 'threema://bridge',
            );
            if (
                encryption?.content?.algorithm !== 'm.megolm.v1.aes-sha2' ||
                marker?.sender !== this.bot.userId ||
                (marker?.content?.network as {id?: unknown} | undefined)?.id !== this.profile ||
                (marker?.content?.channel as {id?: unknown} | undefined)?.id !== chat
            )
                throw new Error('Portal membership ownership verification failed');
            const membership = new Map(
                state
                    .filter((event) => event.type === 'm.room.member')
                    .map((event) => [event.state_key, event.content.membership]),
            );
            // Remove stale ghosts before adding recipients. Native crypto consumes membership through the transaction ingress.
            for (const [mxid, status] of membership) {
                if ((status !== 'join' && status !== 'invite') || desired.has(mxid)) continue;
                const remote = remoteGhostIdentity(this.profile, mxid, this.domain, this.namespace);
                if (!remote) continue;
                if (this.store.ghost(this.profile, remote) !== mxid) continue;
                const intent = this.getIntent(mxid);
                if (intent.userId !== mxid) throw new Error('Ghost intent identity mismatch');
                await intent.leaveRoom(room, 'Threema membership changed');
            }
            for (const [mxid, remote] of desired) {
                const intent = await this.ensure(remote);
                const status = membership.get(mxid);
                if (status === 'ban') throw new Error('Ghost is banned from portal');
                if (status !== 'join') {
                    if (status !== 'invite') await this.bot.underlyingClient.inviteUser(mxid, room);
                    await intent.joinRoom(room);
                }
            }
        });
    }
}
