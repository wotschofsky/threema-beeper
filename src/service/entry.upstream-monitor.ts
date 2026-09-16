import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProfileLock} from '../threema/profile-lock.ts';
import {checkUpstream, parseUpstreamState, reviewUpstream, type UpstreamState} from '../operations/upstream-monitor.ts';

const args = process.argv.slice(2);
const status = args.length === 2 && args[1] === 'status';
const review = args.length === 4 && args[1] === 'review' && /^(0|[1-9][0-9]*)$/.test(args[3]!);
if (!(args.length === 1 || status || review)) {
    process.stderr.write('Usage: node src/service/entry.upstream-monitor.ts <state-directory> [status | review <tags|changelog|terms> <revision>]\n');
    process.exitCode = 2;
} else {
    const directory = resolve(process.argv[2]!);
    let lock: ProfileLock | undefined;
    const temporary = join(directory, `state-${randomUUID()}.tmp`);
    try {
        await mkdir(directory, {recursive: true, mode: 0o700});
        // Reuse the OS-backed empty coordination DB; no linked profile is opened.
        lock = new ProfileLock(join(directory, 'coordination'));
        let state: UpstreamState = {schemaVersion: 1, snapshots: {}, pending: {}};
        try {
            const data = await readFile(join(directory, 'state.json'), 'utf8');
            if (data.length > 8192) throw new Error('Invalid state');
            state = parseUpstreamState(JSON.parse(data));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const result = status ? {state, changed: [], unavailable: []}
            : review ? {state: reviewUpstream(state, args[2]!, Number(args[3])), changed: [], unavailable: []}
            : await checkUpstream(state);
        if (status) {
            process.stdout.write(JSON.stringify({pending: state.pending, revisions: state.revisions ?? {}}) + '\n');
        } else {
            const output = await open(temporary, 'wx', 0o600);
            try {
                await output.writeFile(JSON.stringify(result.state, null, 2) + '\n');
                await output.sync();
            } finally { await output.close(); }
            await rename(temporary, join(directory, 'state.json'));
            const parent = await open(directory, 'r');
            try { await parent.sync(); } finally { await parent.close(); }
        }
        if (review) process.stdout.write('Recorded review of the specified upstream revision.\n');
        if (result.changed.length || result.unavailable.length)
            process.stdout.write(JSON.stringify({changed: result.changed, unavailable: result.unavailable}) + '\n');
        if (result.unavailable.length) process.exitCode = 1;
    } catch {
        process.stderr.write('Upstream operation unavailable. Check arguments, current revision, network access, state permissions or another running check.\n');
        process.exitCode = 1;
    } finally {
        if (lock) {
            await unlink(temporary).catch(() => undefined);
            lock.close();
        }
    }
}
