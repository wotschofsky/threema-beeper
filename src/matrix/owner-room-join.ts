import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';

/** Join only an encrypted portal already verified and mapped by this profile. */
export async function joinOwnerPortal(options: {
    room: string;
    profile: string;
    owner: string;
    botId: string;
    mappedChat: () => string | undefined;
    active: () => boolean;
    bot: Pick<MatrixClient, 'getRoomState' | 'sendStateEvent'>;
    ownerClient: Pick<MatrixClient, 'getWhoAmI' | 'joinRoom'>;
}): Promise<void> {
    const chat = options.mappedChat();
    const assertActive = () => {
        if (!chat || !options.active() || options.mappedChat() !== chat)
            throw new Error('Owner join is outside the active profile');
    };
    assertActive();
    const state = await options.bot.getRoomState(options.room);
    assertActive();
    const marker = state.find(
        (event) => event.type === 'm.bridge' && event.state_key === 'threema://bridge',
    );
    const content = marker?.content;
    if (
        marker?.sender !== options.botId ||
        content?.bridgebot !== options.botId ||
        content?.creator !== options.owner ||
        (content?.network as {id?: unknown} | undefined)?.id !== options.profile ||
        (content?.channel as {id?: unknown} | undefined)?.id !== chat ||
        !state.some(
            (event) =>
                event.type === 'm.room.encryption' &&
                event.state_key === '' &&
                event.content?.algorithm === 'm.megolm.v1.aes-sha2',
        )
    )
        throw new Error('Owner join requires a verified encrypted bridge portal');
    const membership = state.find(
        (event) => event.type === 'm.room.member' && event.state_key === options.owner,
    )?.content?.membership;
    if (membership === 'join') return;
    const whoami = await options.ownerClient.getWhoAmI();
    assertActive();
    if (whoami.user_id !== options.owner) throw new Error('Owner join identity mismatch');
    if (membership !== 'invite') {
        // Private Matrix rooms need authorization before joining. This is automatic
        // membership repair, never a user-facing conversation request.
        await options.bot.sendStateEvent(options.room, 'm.room.member', options.owner, {
            'membership': 'invite',
            'fi.mau.will_auto_accept': true,
            'com.beeper.exclude_from_timeline': true,
        });
        assertActive();
    }
    await options.ownerClient.joinRoom(options.room);
}
