import {resolve} from 'node:path';
import {readServiceConfig} from '../service/config.ts';
import {
    generateProfileSecret,
    readProfileSecret,
    saveProfileSecret,
} from '../setup/profile-secret.ts';
import {createBackup} from './create-backup.ts';
import {restoreBackup} from './restore-backup.ts';
import {verifyRestoreWorkspace} from './verify-workspace.ts';
import {adoptWorkspace} from './adopt-workspace.ts';

const [command, ...args] = process.argv.slice(2);
if (
    !(
        (command === 'init-key' && args.length === 1) ||
        (command === 'verify' && (args.length === 1 || args.length === 2)) ||
        (['create', 'restore', 'adopt'].includes(command!) && args.length === 3)
    )
) {
    process.stderr.write(
        'Usage: pnpm run backup init-key <new-key-file> | verify <workspace> [config.yaml] | adopt <workspace> <config.yaml> <new-installation> | create <config.yaml> <key-file> <new-archive> | restore <archive> <key-file> <new-workspace>\n',
    );
    process.exitCode = 2;
} else {
    let key: Buffer | undefined;
    try {
        if (command === 'verify') {
            await verifyRestoreWorkspace(
                resolve(args[0]!),
                args[1] ? await readServiceConfig(resolve(args[1])) : undefined,
            );
            process.stdout.write(
                'Restored workspace matches its completion record and file manifest. Service compatibility and startup are separate checks.\n',
            );
        } else if (command === 'adopt') {
            await adoptWorkspace(
                resolve(args[0]!),
                await readServiceConfig(resolve(args[1]!)),
                resolve(args[2]!),
            );
            process.stdout.write(
                'Restored installation prepared with bridge.yaml. It has not been started. Stop the original instance before any live use.\n',
            );
        } else if (command === 'init-key') {
            saveProfileSecret(resolve(args[0]!), generateProfileSecret());
            process.stdout.write(
                'Backup key created. Keep a separate protected recovery copy; it is required to decrypt backups.\n',
            );
        } else {
            const keyFile = resolve(args[1]!);
            key = Buffer.from(readProfileSecret(keyFile), 'base64url');
            if (command === 'create') {
                const config = await readServiceConfig(resolve(args[0]!));
                // Compare secret values too, so copied files cannot silently reuse store keys.
                for (const filename of [config.passwordFile, config.matrix.cryptoKeyFile]) {
                    const storeKey = Buffer.from(readProfileSecret(filename), 'base64url');
                    try {
                        if (storeKey.equals(key)) throw new Error();
                    } finally {
                        storeKey.fill(0);
                    }
                }
                await createBackup(config, resolve(args[2]!), key);
                process.stdout.write(
                    'Encrypted backup created. Service state was captured under its profile locks.\n',
                );
            } else {
                await restoreBackup(resolve(args[0]!), resolve(args[2]!), key);
                process.stdout.write(
                    'Backup authenticated and restored into the new workspace. Service adoption and startup are separate operations.\n',
                );
            }
        }
    } catch {
        process.stderr.write(
            'Backup operation failed. Check private paths, key, archive integrity and whether the profile is closed. Existing destinations are never replaced.\n',
        );
        process.exitCode = 1;
    } finally {
        key?.fill(0);
    }
}
