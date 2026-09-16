import {accessSync, constants, lstatSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {readServiceConfig} from '../service/config.ts';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {LinkSession} from './link-session.ts';
import {setupAuditLog} from './audit.ts';
import {runStandaloneSetup} from './standalone.ts';

class SetupUsageError extends Error {}

function privateDirectory(path: string): void {
    try {
        mkdirSync(path, {mode: 0o700});
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        throw new SetupUsageError('The data directory must be a real directory with mode 0700.');
}
function requireMissing(path: string): void {
    try {
        lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    throw new SetupUsageError(
        'A profile or recovery secret already exists. Use the existing profile; setup cannot replace it.',
    );
}

try {
    const {values} = parseArgs({
        options: {
            'data-dir': {type: 'string'},
            'config': {type: 'string'},
            'port': {type: 'string'},
            'help': {type: 'boolean'},
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        console.log(
            'Usage: pnpm run setup (--config /absolute/bridge.yaml | --data-dir /absolute/private/data) [--port 8787]\n\nCreates a new linked Threema profile through a one-time localhost page.\nThe parent directory must exist. Existing profiles are never replaced.\nAfter recovery acknowledgement this command stops; it does not start message bridging.\nFor a remote host, choose a port and forward it with SSH to the same localhost port.',
        );
    } else {
        if (Boolean(values['data-dir']) === Boolean(values.config))
            throw new SetupUsageError(
                'Specify exactly one of --config or --data-dir. Use --help for usage.',
            );
        const config = values.config ? await readServiceConfig(resolve(values.config)) : undefined;
        if (process.versions.node.split('.')[0] !== '24')
            throw new SetupUsageError('Use Node 24 for this build.');
        const port = values.port === undefined ? 0 : Number(values.port);
        if (
            !Number.isInteger(port) ||
            port < 0 ||
            port > 65535 ||
            (values.port !== undefined && !/^\d+$/.test(values.port))
        )
            throw new SetupUsageError('Port must be an integer from 0 to 65535.');
        const root = fileURLToPath(new URL('../../', import.meta.url));
        const wasmFile = config?.wasmFile ?? join(root, '.local/wasm-web/libthreema_bg.wasm');
        for (const path of [
            wasmFile,
            join(root, '.local/setup-ui/setup.js'),
            join(
                root,
                '.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
            ),
        ]) {
            try {
                accessSync(path, constants.R_OK);
            } catch {
                throw new SetupUsageError(
                    'Build the headless backend, WASM and setup UI before running setup. See docs/LOCAL-PAIRING-SETUP.md.',
                );
            }
        }
        const data = config?.dataDirectory ?? resolve(values['data-dir']!);
        const profileDirectory = config?.profileDirectory ?? join(data, 'threema');
        const secretFile = config?.passwordFile ?? join(data, 'secrets', 'threema-profile');
        requireMissing(profileDirectory);
        requireMissing(secretFile);
        privateDirectory(data);
        if (config) privateDirectory(join(data, 'profiles'));
        privateDirectory(dirname(secretFile));
        const controller = new AbortController();
        const interrupt = (): void => controller.abort();
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', interrupt);
        try {
            const result = await runStandaloneSetup(
                new LinkSession({
                    profileDirectory,
                    secretFile,
                    wasmFile,
                    expectedIdentity: config?.identity,
                    onAudit: (event) => {
                        process.stderr.write(setupAuditLog(event));
                    },
                }),
                {
                    port,
                    signal: controller.signal,
                    onUrl: (url) => {
                        console.log('Open this one-time local setup link:\n' + url);
                    },
                },
            );
            console.log(
                result === 'finished'
                    ? 'Profile setup complete. The profile is saved; message bridging is not running.'
                    : 'Setup ended without completion. Any profile that may have registered was preserved.',
            );
            if (result !== 'finished') process.exitCode = result === 'interrupted' ? 130 : 1;
        } finally {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', interrupt);
        }
    }
} catch (error) {
    // Filesystem/backend exceptions may contain private paths or network details.
    const message =
        error instanceof SetupUsageError
            ? error.message
            : 'Setup could not start. Check build artifacts, directory permissions and whether the chosen port is available.';
    console.error(message);
    process.exitCode = 1;
}
