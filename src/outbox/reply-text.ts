/** Split only the leading Matrix plain-text reply fallback; preserve the reply's whitespace. */
export function splitReplyText(text: string): {body: string; quote: string} {
    let offset = 0;
    const quote: string[] = [];
    while (text.startsWith('> ', offset)) {
        const newline = text.indexOf('\n', offset);
        const end = newline === -1 ? text.length : newline;
        quote.push(text.slice(offset + 2, end));
        offset = newline === -1 ? text.length : newline + 1;
    }
    if (offset > 0 && text[offset] === '\n') offset++;
    return {body: text.slice(offset), quote: quote.join('\n')};
}

/** The supplied quote is unverified: label it explicitly instead of inventing remote attribution. */
export function unavailableReplyText(body: string, quote: string): string {
    const excerpt = Array.from(quote.replace(/[\u0000-\u001f\u007f]/g, ' ').trim());
    const summary = excerpt.slice(0, 320).join('') + (excerpt.length > 320 ? '…' : '');
    return summary
        ? `[Reply fallback: original unavailable; client-provided quote]\n> ${summary}\n\n${body}`
        : `[Reply fallback: original unavailable]\n\n${body}`;
}
