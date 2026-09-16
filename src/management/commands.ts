export type ManagementCommand =
    | {kind: 'status' | 'resync' | 'doctor' | 'version' | 'help'}
    | {kind: 'contacts'; after?: string}
    | {kind: 'pm'; identity: string}
    | {kind: 'invalid' | 'local-only'};

/** Strict ASCII command grammar; never include input text in errors or help. */
export function parseManagementCommand(body: unknown): ManagementCommand {
    if (
        typeof body !== 'string' ||
        Buffer.byteLength(body) > 256 ||
        /[\u0000-\u001f\u007f]/.test(body)
    )
        return {kind: 'invalid'};
    const words = body.trim().split(/ +/);
    if (words[0] === '!threema') words.shift();
    if (
        [
            'link',
            'unlock',
            'password',
            'secret',
            'qr',
            'revoke',
            'delete',
            'unlink',
            'reset',
        ].includes(words[0]!)
    )
        return {kind: 'local-only'};
    if (words.length === 1 && ['status', 'resync', 'doctor', 'version', 'help'].includes(words[0]!))
        return {kind: words[0] as 'status' | 'resync' | 'doctor' | 'version' | 'help'};
    if (words[0] === 'contacts') {
        if (words.length === 1) return {kind: 'contacts'};
        if (
            words.length === 3 &&
            words[1] === 'after' &&
            /^[A-Za-z0-9*][A-Za-z0-9]{7}$/.test(words[2]!)
        )
            return {kind: 'contacts', after: words[2]!.toUpperCase()};
    }
    if (words.length === 2 && words[0] === 'pm' && /^[A-Za-z0-9*][A-Za-z0-9]{7}$/.test(words[1]!))
        return {kind: 'pm', identity: words[1]!.toUpperCase()};
    return {kind: 'invalid'};
}

export const managementHelp =
    'Commands: status, contacts, contacts after ABCD1234, !threema pm ABCD1234, resync, doctor, version. Linking, recovery and deletion are available only through local administration.';
