import {EMOJI_LIST} from '../../.local/sources/threema-desktop/apps/desktop/src/app/ui/linking/emoji-list.ts';

/** Same first-three-byte indexing as upstream ConfirmEmoji and LinkingEmojiLoader. */
export function linkingEmojis(rendezvousPathHash: Uint8Array): string[] {
    if (rendezvousPathHash.length < 3) throw new Error('Invalid rendezvous path hash');
    return Array.from(rendezvousPathHash.subarray(0, 3), (byte) => {
        const codepoints = EMOJI_LIST[byte % EMOJI_LIST.length]!;
        return String.fromCodePoint(
            ...codepoints.map((codepoint) => Number.parseInt(codepoint, 16)),
        );
    });
}
