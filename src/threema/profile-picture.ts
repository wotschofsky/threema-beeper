/** Bound untrusted worker results; no model controllers or arbitrary objects cross this API. */
export function parseProfilePicture(value: unknown): Uint8Array | null {
    if (value === null) return null;
    if (
        !(value instanceof Uint8Array) ||
        value.byteLength === 0 ||
        value.byteLength > 2 * 1024 * 1024
    )
        throw new Error('Invalid contact picture');
    return new Uint8Array(value);
}
export function pictureIdentity(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !/^(?:[A-Z0-9*][A-Z0-9]{7}|g:[A-Z0-9*][A-Z0-9]{7}:[0-9a-f]{16})$/.test(value)
    )
        throw new Error('Invalid contact picture identity');
    return value;
}
