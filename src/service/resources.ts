import {deriveStoreKey} from './store-key.ts';
import {closeSync, constants, lstatSync, mkdirSync, openSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {readProfileSecret} from '../setup/profile-secret.ts';
import {ProfileLock} from '../threema/profile-lock.ts';
import {MessageJournal} from '../threema/message-journal.ts';
import {TransactionInbox} from '../matrix/transaction-inbox.ts';
import {PortalStore} from '../matrix/portal-store.ts';
import {OutboxStore} from '../outbox/store.ts';
import type {ServiceConfig} from './config.ts';

function privateDirectory(directory: string): void {
    const stat = lstatSync(directory);
    if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
    )
        throw new Error('Service data requires private owned directories');
}
function childDirectory(parent: string, name: string): string {
    privateDirectory(parent);
    const directory = join(parent, name);
    try {
        mkdirSync(directory, {mode: 0o700});
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    privateDirectory(directory);
    return directory;
}
function databaseFile(filename: string): string {
    try {
        closeSync(
            openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600),
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    for (const name of [filename, filename + '-wal', filename + '-shm', filename + '-journal']) {
        try {
            const stat = lstatSync(name);
            if (
                !stat.isFile() ||
                stat.isSymbolicLink() ||
                stat.mode & 0o077 ||
                (process.getuid !== undefined && stat.uid !== process.getuid())
            )
                throw new Error('Unsafe bridge database file');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    return filename;
}
export interface BridgeResources {
    journal: MessageJournal;
    inbox: TransactionInbox;
    portals: PortalStore;
    outbox: OutboxStore;
    matrixDirectory: string;
    /** Separate native/appservice root key; wiped on close after native clients must have stopped. */
    matrixKey: Buffer;
    checkHealth(): boolean;
    close(): void;
}

/** Initialize service-owned paths/stores only. Never link a device or create/replace a master key. */
export function openBridgeResources(config: ServiceConfig): BridgeResources {
    privateDirectory(config.dataDirectory);
    if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.profileId) ||
        !/^[A-Z0-9*][A-Z0-9]{7}$/.test(config.identity)
    )
        throw new Error('Invalid resource profile');
    const profiles = childDirectory(config.dataDirectory, 'profiles');
    const profileDirectory = childDirectory(profiles, config.profileId);
    if (profileDirectory !== config.profileDirectory)
        throw new Error('Configured profile path conflict');
    const bridge = childDirectory(childDirectory(config.dataDirectory, 'bridge'), config.profileId);
    const runtime = childDirectory(config.dataDirectory, 'runtime');
    const mediaRelative = relative(runtime, config.media.temporaryDirectory);
    if (
        !mediaRelative ||
        mediaRelative === '..' ||
        mediaRelative.startsWith('..' + sep) ||
        mediaRelative.startsWith(sep)
    )
        throw new Error('Media temporary directory must be beneath the runtime directory');
    let media = runtime;
    for (const name of mediaRelative.split(sep)) media = childDirectory(media, name);
    const matrixDirectory = childDirectory(bridge, 'matrix');
    const lock = new ProfileLock(bridge);
    const opened: {close(): void}[] = [lock];
    const derived: Buffer[] = [];
    let master: Buffer | undefined;
    try {
        // Ciphertext cleanup is safe only if no other profile owns this temporary directory.
        opened.push(new ProfileLock(media));
        master = Buffer.from(readProfileSecret(config.matrix.cryptoKeyFile), 'base64url');
        const key = (purpose: Parameters<typeof deriveStoreKey>[2]): Buffer => {
            const value = deriveStoreKey(master!, config, purpose);
            derived.push(value);
            return value;
        };
        const journal = new MessageJournal(
            databaseFile(join(bridge, 'journal.sqlite')),
            key('journal'),
            config.identity,
        );
        opened.push(journal);
        const inbox = new TransactionInbox(
            databaseFile(join(bridge, 'inbox.sqlite')),
            key('inbox'),
        );
        opened.push(inbox);
        const portals = new PortalStore(
            databaseFile(join(bridge, 'portals.sqlite')),
            key('portals'),
        );
        opened.push(portals);
        const outbox = new OutboxStore(databaseFile(join(bridge, 'outbox.sqlite')), key('outbox'));
        opened.push(outbox);
        const matrixKey = Buffer.from(key('matrix'));
        let closed = false;
        return {
            journal,
            inbox,
            portals,
            outbox,
            matrixDirectory,
            matrixKey,
            checkHealth() {
                if (closed) return false;
                try {
                    journal.checkHealth();
                    inbox.checkHealth();
                    portals.checkHealth();
                    outbox.checkHealth();
                    return true;
                } catch {
                    return false;
                }
            },
            close() {
                if (closed) return;
                closed = true;
                let failed = false;
                for (const resource of [...opened].reverse()) {
                    try {
                        resource.close();
                    } catch {
                        failed = true;
                    }
                }
                matrixKey.fill(0);
                if (failed) throw new Error('Bridge resources failed to close');
            },
        };
    } catch (error) {
        for (const resource of opened.reverse()) {
            try {
                resource.close();
            } catch {
                /* Preserve initialization error. */
            }
        }
        throw error;
    } finally {
        master?.fill(0);
        derived.forEach((key) => key.fill(0));
    }
}
