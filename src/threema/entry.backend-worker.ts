import {createRequire} from 'node:module';
import {parentPort, workerData} from 'node:worker_threads';
import {ProfileLock, ProfileInUseError} from './profile-lock.ts';
import {serveBackendSession, type BackendSession} from './backend-session-router.ts';
import {parseConnectionIssue} from '../../integrations/threema/overlay/src/headless/node-connection-issue.ts';

const port = parentPort;
if (!port) throw new Error('Headless backend requires a worker');
const options = workerData as {profileDirectory: string; wasmFile: string};
const backend: {
    probe(wasm: string, profile: string): Promise<unknown>;
    getNodeMediaLimits(): {maximumBytes: number};
    createNodeSession(
        profile: string,
        onLink: (state: Record<string, unknown>) => void,
        onLoad: (state: Record<string, unknown>) => void,
        onConnectionIssue: (issue: unknown) => void,
    ): BackendSession;
} = createRequire(import.meta.url)(
    '../../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);

let lock: ProfileLock | undefined;
try {
    lock = new ProfileLock(options.profileDirectory);
    port.on('close', () => lock?.close());
    await backend.probe(options.wasmFile, options.profileDirectory);
    const session = backend.createNodeSession(
        options.profileDirectory,
        (state) => {
            // Error detail can contain network URLs; only forward the typed category.
            const safe = state.state === 'error' ? {state: 'error', type: state.type} : state;
            port.postMessage({type: 'link-state', state: safe});
        },
        (state) => {
            port.postMessage({type: 'load-state', state});
        },
        issue => {
            const code = parseConnectionIssue(issue);
            if (code) port.postMessage({type: 'connection-issue', code});
        },
    );
    serveBackendSession(port, session, () => backend.getNodeMediaLimits());
} catch (error) {
    lock?.close();
    port.postMessage({
        type: 'fatal',
        code:
            error instanceof ProfileInUseError ? 'profile-in-use' : 'backend-initialization-failed',
    });
    port.close();
}
