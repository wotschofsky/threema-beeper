import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import type {PortalStore} from '../matrix/portal-store.ts';
import type {TextRequest} from './store.ts';

export interface DispatchGuardOptions {
    owner: string;
    profile: string;
    portals: PortalStore;
    bot: {userId: string; underlyingClient: Pick<MatrixClient, 'getRoomState'>};
}
/** Fresh room state, without a stale-cache fallback. Never creates portals or changes membership. */
export class DispatchGuard {
    private readonly options: DispatchGuardOptions;
    constructor(options: DispatchGuardOptions) {
        if (
            !/^@[^\s]+:[^\s]+$/.test(options.owner) ||
            !/^[A-Z0-9*][A-Z0-9]{7}$/.test(options.profile) ||
            !/^@[^\s]+:[^\s]+$/.test(options.bot.userId)
        )
            throw new Error('Invalid dispatch configuration');
        this.options = options;
    }
    async check(
        request: Pick<TextRequest, 'profile' | 'sender' | 'chatId' | 'roomId'>,
    ): Promise<void> {
        const {owner, profile, portals, bot} = this.options;
        const mapped = () =>
            request.profile === profile &&
            request.sender === owner &&
            portals.get(profile, request.chatId) === request.roomId;
        if (!mapped()) throw new Error('Outbound portal identity conflict');
        const state = await bot.underlyingClient.getRoomState(request.roomId);
        if (!Array.isArray(state)) throw new Error('Invalid outbound room state');
        const exactlyOne = (type: string, key: string) => {
            const matches = state.filter(
                (event) => event?.type === type && event.state_key === key,
            );
            if (matches.length !== 1) throw new Error('Outbound room state is incomplete');
            return matches[0]!;
        };
        const encryption = exactlyOne('m.room.encryption', '');
        const marker = exactlyOne('m.bridge', 'threema://bridge');
        const member = exactlyOne('m.room.member', owner);
        if (
            !mapped() ||
            encryption.content?.algorithm !== 'm.megolm.v1.aes-sha2' ||
            marker.sender !== bot.userId ||
            marker.content?.creator !== owner ||
            (marker.content?.network as {id?: unknown} | undefined)?.id !== profile ||
            (marker.content?.channel as {id?: unknown} | undefined)?.id !== request.chatId ||
            member.content?.membership !== 'join'
        )
            throw new Error('Outbound room authorization failed');
    }
}
