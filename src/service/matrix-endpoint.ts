/** Preserve the pinned bbctl per-owner API prefix instead of silently dropping it. */
export function matrixEndpoint(value: string, owner: string): string {
    try {
        if (value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) throw new Error();
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
            throw new Error();
        if (url.pathname === '/') return url.origin;
        const separator = owner.indexOf(':');
        if (!owner.startsWith('@') || separator < 2) throw new Error();
        const path = `/_hungryserv/${encodeURIComponent(owner.slice(1, separator))}`;
        if (url.pathname !== path && url.pathname !== path + '/') throw new Error();
        return url.origin + path;
    } catch {
        throw new Error('Invalid Matrix API endpoint');
    }
}
