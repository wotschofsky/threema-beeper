import {randomBytes} from 'node:crypto';
import {
    closeSync,
    constants,
    fstatSync,
    fsyncSync,
    linkSync,
    lstatSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import {basename, dirname, isAbsolute, join} from 'node:path';

/** Generate the password representation passed to upstream key storage, not a custom KDF. */
export function generateProfileSecret(): string {
    const bytes = randomBytes(32);
    try {
        return bytes.toString('base64url');
    } finally {
        bytes.fill(0);
    }
}

function validateSecret(secret: string): void {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invalid recovery secret format');
    const decoded = Buffer.from(secret, 'base64url');
    try {
        if (decoded.length !== 32 || decoded.toString('base64url') !== secret)
            throw new Error('Invalid recovery secret encoding');
    } finally {
        decoded.fill(0);
    }
}

/** Atomically publish a new mode-0400 secret without replacing an existing file. */
export function saveProfileSecret(filename: string, secret: string): void {
    if (!isAbsolute(filename)) throw new Error('Secret path must be absolute');
    validateSecret(secret);
    const parent = dirname(filename);
    const directory = lstatSync(parent);
    if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
    ) {
        throw new Error('Secret creation requires a private real directory');
    }
    const temporary = join(
        parent,
        '.' + basename(filename) + '-' + randomBytes(16).toString('hex'),
    );
    const descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o400,
    );
    let open = true;
    const encoded = Buffer.from(secret + '\n');
    try {
        writeFileSync(descriptor, encoded);
        fsyncSync(descriptor);
        closeSync(descriptor);
        open = false;
        // link() publishes the completed inode atomically and fails if the destination exists.
        linkSync(temporary, filename);
        const parentDescriptor = openSync(parent, constants.O_RDONLY);
        try {
            fsyncSync(parentDescriptor);
        } finally {
            closeSync(parentDescriptor);
        }
    } finally {
        encoded.fill(0);
        if (open) closeSync(descriptor);
        unlinkSync(temporary);
    }
}

/** Read a regular, private secret file without following a symlink. No secret enters argv/env. */
export function readProfileSecret(filename: string): string {
    if (!isAbsolute(filename)) throw new Error('Secret path must be absolute');
    const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(descriptor);
        if (
            !stat.isFile() ||
            stat.size > 128 ||
            (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o400)
        ) {
            throw new Error('Profile secret must be a small mode-0400 regular file');
        }
        const bytes = readFileSync(descriptor);
        try {
            const secret = bytes.toString('utf8').replace(/\n$/, '');
            validateSecret(secret);
            return secret;
        } finally {
            bytes.fill(0);
        }
    } finally {
        closeSync(descriptor);
    }
}
