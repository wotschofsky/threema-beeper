import {join} from 'node:path';
import {readProfileSecret} from '../setup/profile-secret.ts';
import type {ServiceConfig} from './config.ts';
import {deriveStoreKey} from './store-key.ts';
import {privacyDoctor} from './privacy-doctor.ts';

/** Reads encrypted schema pages only; never invokes store constructors or runs migrations. */
export async function databaseDoctor(
    config: ServiceConfig,
    options: {requireCurrentSchema?: boolean} = {},
): Promise<{name: string; status: 'pass' | 'fail' | 'unknown'; detail: string}> {
    const name = 'database-unlock';
    const privacy = await privacyDoctor(config);
    const roles = ['data', 'bridge-parent', 'bridge', 'matrix-key'];
    const safe = privacy.paths.filter(
        (path) =>
            roles.includes(path.role) ||
            /^(journal|inbox|portals|outbox)-(database|wal|shm|journal)$/.test(path.role),
    );
    if (
        !safe.every(
            (path) => path.status === 'private' || (!path.required && path.status === 'missing'),
        )
    )
        return {
            name,
            status: 'unknown',
            detail: 'Skipped because database or key paths did not pass private metadata checks.',
        };
    let master: Buffer | undefined;
    try {
        master = Buffer.from(readProfileSecret(config.matrix.cryptoKeyFile), 'base64url');
        const {default: Database} = await import(
            '../../.local/sources/threema-desktop/apps/desktop/node_modules/better-sqlcipher/lib/index.js'
        );
        for (const purpose of ['journal', 'inbox', 'portals', 'outbox'] as const) {
            const key = deriveStoreKey(master, config, purpose);
            let database;
            try {
                database = new Database(
                    join(config.dataDirectory, 'bridge', config.profileId, purpose + '.sqlite'),
                    {readonly: true, fileMustExist: true, timeout: 0},
                );
                database.pragma('cipher_log_level = NONE');
                database.pragma('cipher_compatibility = 4');
                database.pragma(`key = "x'${key.toString('hex')}'"`);
                database.pragma('query_only = ON');
                const schema = database
                    .prepare('SELECT count(*) AS count FROM sqlite_master WHERE type = ?')
                    .get('table') as {count: number};
                if (schema.count < 1) throw new Error();
                if (options.requireCurrentSchema) {
                    const supported = {journal: 4, inbox: 3, portals: 9, outbox: 17};
                    if (database.pragma('user_version', {simple: true}) !== supported[purpose])
                        throw new Error('Schema requires explicit migration review');
                }
            } finally {
                database?.close();
                key.fill(0);
            }
        }
        return {
            name,
            status: 'pass',
            detail: options.requireCurrentSchema
                ? 'All bridge stores opened with current schema versions; no migrations or message rows read. Full integrity and native stores are not verified.'
                : 'All four bridge database schemas opened with derived keys; no migrations or message rows read. Full integrity and native Matrix/Threema stores are not verified.',
        };
    } catch {
        return {
            name,
            status: 'fail',
            detail: 'Unable to read all bridge database schemas with the configured key. Check key/identity configuration, corruption, schema compatibility or lock contention.',
        };
    } finally {
        master?.fill(0);
    }
}
