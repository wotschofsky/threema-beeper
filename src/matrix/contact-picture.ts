import {createHash} from 'node:crypto';
import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';
import {parseProfilePicture} from '../threema/profile-picture.ts';

type PictureClient = Pick<MatrixClient, 'getRoomState' | 'sendStateEvent' | 'uploadContent'>;
type AvatarClient = Pick<MatrixClient, 'getUserProfile' | 'setAvatarUrl'>;
const hashKey = 'com.threema.avatar_sha256';
const mxc = /^mxc:\/\/[^/\s]+\/[A-Za-z0-9_-]+$/;

/** Refresh only a verified conversation's contact picture; Matrix state caches its content hash. */
export async function syncContactPicture(options: {
    room: string;
    profile: string;
    chat: string;
    owner: string;
    botId: string;
    ghostId?: string;
    bot: PictureClient;
    ghost?: AvatarClient;
    read: (identity: string) => Promise<Uint8Array | null>;
}): Promise<void> {
    if (!/^(?:c:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(options.chat))
        throw new Error('Contact picture requires a direct chat');
    const state = await options.bot.getRoomState(options.room);
    const marker = state.find((e) => e.type === 'm.bridge' && e.state_key === 'threema://bridge');
    if (
        marker?.sender !== options.botId ||
        marker.content?.creator !== options.owner ||
        (marker.content?.network as {id?: unknown})?.id !== options.profile ||
        (marker.content?.channel as {id?: unknown})?.id !== options.chat ||
        !state.some(
            (e) =>
                e.type === 'm.room.encryption' && e.content?.algorithm === 'm.megolm.v1.aes-sha2',
        )
    )
        throw new Error('Contact picture room verification failed');
    const previous = state.find((e) => e.type === 'm.room.avatar' && e.state_key === '')?.content;
    const bytes = parseProfilePicture(
        await options.read(options.chat.startsWith('c:') ? options.chat.slice(2) : options.chat),
    );
    if (bytes === null) {
        // Never clear a manually selected avatar or the protocol's fallback icon.
        if (typeof previous?.[hashKey] !== 'string' || !/^[a-f0-9]{64}$/.test(previous[hashKey]))
            return;
        if (options.ghost && options.ghostId) {
            const profile = await options.ghost.getUserProfile(options.ghostId);
            if (profile.avatar_url === previous.url) await options.ghost.setAvatarUrl('');
        }
        await options.bot.sendStateEvent(options.room, 'm.room.avatar', '', {});
        return;
    }
    const content = Buffer.from(bytes);
    const type = content.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        ? 'image/jpeg'
        : content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? 'image/png'
          : undefined;
    if (!type) throw new Error('Unsupported contact picture format');
    const hash = createHash('sha256').update(content).digest('hex');
    let url =
        previous?.[hashKey] === hash && typeof previous.url === 'string' && mxc.test(previous.url)
            ? previous.url
            : undefined;
    if (!url)
        url = await options.bot.uploadContent(
            content,
            type,
            'contact.' + (type === 'image/png' ? 'png' : 'jpg'),
        );
    if (!mxc.test(url)) throw new Error('Invalid contact picture upload result');
    if (previous?.url !== url || previous?.[hashKey] !== hash)
        await options.bot.sendStateEvent(options.room, 'm.room.avatar', '', {url, [hashKey]: hash});
    if (options.ghost && options.ghostId) {
        const profile = await options.ghost.getUserProfile(options.ghostId);
        if (profile.avatar_url !== url) await options.ghost.setAvatarUrl(url);
    }
}
