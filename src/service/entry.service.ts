import {LogService} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {resolve} from 'node:path';
import {readServiceConfig} from './config.ts';
import {startService} from './start.ts';
import {lifecycleLog, type LifecycleEvent} from './lifecycle-log.ts';

// SDK diagnostics can include request bodies/URLs. Service-level messages use fixed categories.
LogService.setLogger({info() {}, warn() {}, error() {}, debug() {}, trace() {}});
const filename = process.argv[2];
if (!filename || process.argv.length !== 3) {
    process.stderr.write('Usage: node src/service/entry.service.ts <config.yaml>\n');
    process.exitCode = 2;
} else {
    const abort = new AbortController();
    const stop = () => abort.abort();
    let requestResync: (() => void) | undefined;
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let phase: 'configure' | 'start' | 'stop' = 'configure';
    let phaseStarted = performance.now();
    const log = (event: LifecycleEvent) => {
        const line = lifecycleLog(event, performance.now() - phaseStarted);
        (event.endsWith('failed') || event.endsWith('rejected')
            ? process.stderr
            : process.stdout
        ).write(line);
    };
    try {
        const config = await readServiceConfig(resolve(filename));
        log('configuration-accepted');
        phase = 'start';
        phaseStarted = performance.now();
        const service = await startService(config, abort.signal);
        requestResync = () => {
            process.stdout.write(
                lifecycleLog(service.resync() ? 'resync-requested' : 'resync-unavailable', 0),
            );
        };
        process.on('SIGUSR2', requestResync);
        log('service-started');
        if (!abort.signal.aborted)
            await new Promise<void>((done) =>
                abort.signal.addEventListener('abort', () => done(), {once: true}),
            );
        phase = 'stop';
        phaseStarted = performance.now();
        await service.close();
        log('service-stopped');
    } catch {
        log(
            phase === 'configure'
                ? 'configuration-rejected'
                : phase === 'start'
                  ? 'service-start-failed'
                  : 'service-stop-failed',
        );
        process.exitCode = 1;
    } finally {
        if (requestResync) process.removeListener('SIGUSR2', requestResync);
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
}
