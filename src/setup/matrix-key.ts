import {lstatSync, realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {ServiceConfig} from '../service/config.ts';
import {generateProfileSecret, saveProfileSecret} from './profile-secret.ts';

function absent(path: string): void {
    try {
        lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    throw new Error(
        'Matrix key initialization requires a fresh destination and no existing bridge profile',
    );
}
function privateDirectory(path: string): void {
    const stat = lstatSync(path);
    if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        realpathSync(path) !== path
    )
        throw new Error('Matrix key initialization requires private owned real directories');
}

/** Explicit local initialization only. Service startup must never regenerate a missing store key. */
export function initializeMatrixKey(config: ServiceConfig): void {
    if (config.matrix.cryptoKeyFile === config.passwordFile)
        throw new Error('Matrix and Threema secrets require separate files');
    privateDirectory(config.dataDirectory);
    privateDirectory(dirname(config.matrix.cryptoKeyFile));
    const bridge = join(config.dataDirectory, 'bridge');
    try {
        lstatSync(bridge);
        privateDirectory(bridge);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    absent(join(bridge, config.profileId));
    absent(config.matrix.cryptoKeyFile);
    saveProfileSecret(config.matrix.cryptoKeyFile, generateProfileSecret());
}
