import {lstatSync, mkdirSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import Database from '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js';

export class ProfileInUseError extends Error {
    readonly code = 'profile-in-use';
    constructor() {
        super('Profile is already open in another bridge worker');
    }
}

/**
 * An OS-backed SQLite exclusive lock. This empty coordination database contains no identity,
 * credentials, or messages. Never remove it to break a lock: doing so would split lock ownership.
 */
export class ProfileLock {
    private readonly database: Database.Database;
    private closed = false;

    constructor(directory: string) {
        if (!isAbsolute(directory)) throw new Error('Profile path must be absolute');
        mkdirSync(directory, {recursive: true, mode: 0o700});
        const info = lstatSync(directory);
        if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
        ) {
            throw new Error('Profile must be a private real directory');
        }
        const filename = join(directory, '.bridge-profile-lock.sqlite');
        try {
            const existing = lstatSync(filename);
            if (!existing.isFile() || existing.isSymbolicLink())
                throw new Error('Invalid profile lock file');
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
        }
        this.database = new Database(filename, {timeout: 0});
        try {
            this.database.pragma('journal_mode = DELETE');
            this.database.exec(
                'CREATE TABLE IF NOT EXISTS lease (singleton INTEGER PRIMARY KEY CHECK(singleton = 1))',
            );
            this.database.exec('BEGIN EXCLUSIVE');
        } catch (error) {
            this.database.close();
            if (
                error instanceof Error &&
                'code' in error &&
                (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
            )
                throw new ProfileInUseError();
            throw error;
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            this.database.exec('ROLLBACK');
        } finally {
            this.database.close();
        }
    }
}
