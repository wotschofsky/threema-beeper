import {lstat, opendir, rm} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';

/** Startup only, while holding exclusive profile ownership. Never follows directory symlinks. */
export async function cleanupAttachmentSpools(
    parent: string,
    retained: ReadonlySet<string>,
): Promise<void> {
    if (!isAbsolute(parent)) throw new Error('Invalid attachment cleanup directory');
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
        throw new Error('Attachment cleanup requires a private directory');
    // Validate the full reference set before deleting any entries.
    for (const name of retained)
        if (!/^attachment-[A-Za-z0-9]{6}$/.test(name))
            throw new Error('Invalid retained attachment spool');
    const entries = await opendir(parent);
    for await (const entry of entries) {
        if (!/^attachment-[A-Za-z0-9]{6}$/.test(entry.name) || retained.has(entry.name)) continue;
        // rm unlinks symlinks themselves, including nested links; it does not traverse targets.
        // Unknown files outside our exact mkdtemp namespace are never removed.
        await rm(join(parent, entry.name), {recursive: true, force: true});
    }
}

/** Outbound downloads are reproducible and have no durable spool references. Startup only. */
export async function cleanupOutboundAttachmentSpools(parent: string): Promise<void> {
    if (!isAbsolute(parent)) throw new Error('Invalid attachment cleanup directory');
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
        throw new Error('Attachment cleanup requires a private directory');
    const entries = await opendir(parent);
    for await (const entry of entries) {
        if (!/^outbound-attachment-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
        await rm(join(parent, entry.name), {recursive: true, force: true});
    }
}
