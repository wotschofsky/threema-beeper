import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import type {InboxEvent} from '../matrix/transaction-inbox.ts';

type Client = Pick<MatrixClient, 'getJoinedRooms'> & {
    crypto: Pick<MatrixClient['crypto'], 'isReady' | 'onRoomEvent' | 'onRoomJoin'>;
};
/** Route owned-room crypto state only to initialized clients participating in that room. */
export class RoomStateRouter {
    private readonly clients = new Map<string, {client: Client; rooms: Set<string>}>();
    private tail: Promise<unknown> = Promise.resolve();
    private readonly bot: string;
    private readonly owned: (room: string) => boolean;
    constructor(bot: string, owned: (room: string) => boolean) {
        this.bot = bot;
        this.owned = owned;
    }
    has(user: string): boolean {
        return this.clients.has(user);
    }
    private queue(action: () => Promise<void>): Promise<void> {
        const task = this.tail.then(action);
        this.tail = task.catch(() => {});
        return task;
    }
    register(user: string, client: Client): Promise<void> {
        return this.queue(() => this.restore(user, client));
    }
    private async restore(user: string, client: Client): Promise<void> {
        const rooms = await client.getJoinedRooms();
        if (
            !Array.isArray(rooms) ||
            rooms.length > 100000 ||
            rooms.some((room) => typeof room !== 'string' || !/^![^\s]+:[^\s]+$/.test(room))
        )
            throw new Error('Invalid joined-room snapshot');
        const ownedRooms = new Set(rooms.filter(this.owned));
        for (const room of ownedRooms) await client.crypto.onRoomJoin(room);
        this.clients.set(user, {client, rooms: ownedRooms});
    }
    joined(user: string, room: string): void {
        if (this.owned(room)) this.clients.get(user)?.rooms.add(room);
    }
    left(user: string, room: string): void {
        this.clients.get(user)?.rooms.delete(room);
    }
    clear(): void {
        this.clients.clear();
    }
    apply(event: InboxEvent): Promise<void> {
        return this.queue(() => this.route(event));
    }
    private async route(event: InboxEvent): Promise<void> {
        if (
            !this.owned(event.room_id) ||
            typeof event.state_key !== 'string' ||
            !['m.room.member', 'm.room.encryption', 'm.room.history_visibility'].includes(
                event.type,
            )
        )
            return;
        if (!this.clients.has(this.bot)) throw new Error('Bot room tracker is unavailable');
        for (const [user, {client, rooms}] of this.clients) {
            const selfMembership = event.type === 'm.room.member' && event.state_key === user;
            const joined = selfMembership && event.content.membership === 'join';
            if (user !== this.bot && !rooms.has(event.room_id) && !selfMembership) continue;
            if (!client.crypto.isReady) throw new Error('Room crypto is not ready');
            if (joined) await client.crypto.onRoomJoin(event.room_id);
            await client.crypto.onRoomEvent(event.room_id, event);
            if (joined) rooms.add(event.room_id);
            else if (selfMembership) rooms.delete(event.room_id);
        }
    }
}
