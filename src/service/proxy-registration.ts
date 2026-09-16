import {constants} from 'node:fs';
import {lstat, realpath, open, link, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, normalize, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {stringify} from '../../.local/sources/matrix-appservice-bridge/node_modules/yaml/dist/index.js';
import type {ServiceConfig} from './config.ts';
import {readRegistration} from './registration.ts';

/** Explicit local export only. Publish complete private YAML without replacing an existing file. */
export async function exportProxyRegistration(
    config: ServiceConfig,
    destination: string,
): Promise<void> {
    let temporary: string | undefined;
    let bytes: Buffer | undefined;
    try {
        if (!isAbsolute(destination) || normalize(destination) !== destination) throw new Error();
        const parent = dirname(destination);
        const stat = await lstat(parent);
        if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.mode & 0o077 ||
            (process.getuid && stat.uid !== process.getuid()) ||
            (await realpath(parent)) !== parent
        )
            throw new Error();
        const {registration} = await readRegistration(config);
        bytes = Buffer.from(stringify(registration.getOutput()), 'utf8');
        temporary = join(parent, `.proxy-registration-${randomUUID()}`);
        const file = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        try {
            await file.writeFile(bytes);
            await file.sync();
        } finally {
            await file.close();
        }
        // Hard-link publication is atomic and fails for any existing destination, including links.
        await link(temporary, destination);
        await unlink(temporary);
        temporary = undefined;
        const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } catch {
        throw new Error('Unable to export private proxy registration');
    } finally {
        bytes?.fill(0);
        if (temporary) await unlink(temporary).catch(() => {});
    }
}
