import * as fs from 'node:fs';
import * as path from 'node:path';

import {STATIC_CONFIG} from '~/common/config';
import type {FactoriesForBackend} from '~/common/dom/backend';
import {NOOP_LOGGER} from '~/common/logging';
import {ZlibCompressor} from '~/common/node/compressor';
import {SqliteDatabaseBackend} from '~/common/node/db/sqlite';
import {FileSystemFileStorage} from '~/common/node/file-storage/system-file-storage';
import {TempFileSystemFileStorage} from '~/common/node/file-storage/temp-system-file-storage';
import {FileSystemKeyStorage} from '~/common/node/key-storage';
import {getIsAnyKeyStorageFilePresent, getKeyStoragePath} from '~/common/node/key-storage/helpers';

/** No Electron settings, UI process, console logging or legacy-profile access. */
export function createNodeFactories(
    profileDirectory: string,
    onFileStorage?: (storage: FileSystemFileStorage) => void,
): FactoriesForBackend {
    if (!path.isAbsolute(profileDirectory)) {
        throw new Error('Headless profile path must be absolute');
    }
    fs.mkdirSync(profileDirectory, {recursive: true, mode: 0o700});
    const profile = fs.lstatSync(profileDirectory);
    if (!profile.isDirectory() || profile.isSymbolicLink()) {
        throw new Error('Headless profile must be a real directory');
    }
    // eslint-disable-next-line no-bitwise -- POSIX permissions are a bit mask.
    if (process.platform !== 'win32' && (profile.mode & 0o077) !== 0) {
        throw new Error('Headless profile directory must have mode 0700');
    }
    function requireCurrentProfile(loadFromOldProfile?: boolean): void {
        if (loadFromOldProfile === true) {
            throw new Error('Restoring an external Desktop profile is unsupported');
        }
    }
    function createDirectory(directory: string): void {
        fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    }
    return {
        hasIdentity: () => getIsAnyKeyStorageFilePresent(profileDirectory),
        logging: () => ({logger: () => NOOP_LOGGER}),
        keyStorage: (services, log, loadFromOldProfile) => {
            requireCurrentProfile(loadFromOldProfile);
            createDirectory(path.dirname(getKeyStoragePath(profileDirectory)));
            return new FileSystemKeyStorage(services, log, profileDirectory);
        },
        fileStorage: (services, log, loadFromOldProfile) => {
            requireCurrentProfile(loadFromOldProfile);
            const directory = path.join(profileDirectory, ...STATIC_CONFIG.FILE_STORAGE_PATH);
            createDirectory(directory);
            const storage = new FileSystemFileStorage(services, log, directory);
            onFileStorage?.(storage);
            return storage;
        },
        tempFileStorage: (log) => {
            const directory = path.join(profileDirectory, 'temp');
            createDirectory(directory);
            return new TempFileSystemFileStorage(log, directory);
        },
        compressor: () => new ZlibCompressor(),
        db: (services, log, supplements, key, shouldExist, loadFromOldProfile) => {
            requireCurrentProfile(loadFromOldProfile);
            if (services.config.DATABASE_PATH === ':memory:') {
                throw new Error('Headless profiles require a persistent database');
            }
            const filename = path.join(profileDirectory, ...services.config.DATABASE_PATH);
            if (shouldExist && !fs.existsSync(filename)) {
                throw new Error('Linked profile database is missing');
            }
            if (
                !shouldExist &&
                [filename, `${filename}-wal`, `${filename}-shm`].some((file) => fs.existsSync(file))
            ) {
                throw new Error('New linking requires an empty profile database');
            }
            createDirectory(path.dirname(filename));
            const backend = SqliteDatabaseBackend.create(log, supplements, filename, key);
            try {
                backend.runMigrations();
                backend.checkIntegrity();
                return backend;
            } catch (error) {
                backend.close();
                throw error;
            }
        },
    };
}
