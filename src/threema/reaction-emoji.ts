import {createRequire} from 'node:module';
// Use the same pinned emoji data as the native Threema runtime.
const data = createRequire(import.meta.url)(
    '../../.local/sources/threema-desktop/apps/desktop/node_modules/emojibase-data/meta/hexcodes.json',
) as Record<string, Record<string, number>>;
const variants = new Map<string, string>();
const unicode = (hex: string) =>
    String.fromCodePoint(...hex.split('-').map((n) => parseInt(n, 16)));
for (const [base, forms] of Object.entries(data)) {
    const full = Object.keys(forms).filter((hex) => forms[hex] === 0 && !hex.endsWith('FE0E'));
    const chosen = full.find((hex) => !hex.endsWith('FE0F')) ?? full[0];
    if (!chosen) continue;
    const canonical = unicode(chosen);
    for (const hex of [base, ...Object.keys(forms)]) variants.set(unicode(hex), canonical);
}
/** Accept presentation variants such as Beeper's overqualified thumbs-up. */
export function normalizeReactionEmoji(emoji: string): string {
    return variants.get(emoji) ?? emoji;
}
