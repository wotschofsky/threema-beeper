import {lstatSync} from 'node:fs';
import {BackendController} from './backend-controller.ts';
import type {ConnectionIssue} from '../../integrations/threema/overlay/src/headless/node-connection-issue.ts';
import {readProfileSecret} from '../setup/profile-secret.ts';

/** Reopen an existing profile without ever falling back to linking a new device. */
export async function openSavedProfile(options: {
    profileDirectory: string;
    secretFile: string;
    wasmFile: string;
    signal?: AbortSignal;
    onConnectionIssue?: (issue: ConnectionIssue) => void;
}): Promise<{identity: string; backend: BackendController; close: () => Promise<void>}> {
    options.signal?.throwIfAborted();
    const stat = lstatSync(options.profileDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        throw new Error('Saved profile must be a private real directory');
    let secret: string | undefined = readProfileSecret(options.secretFile);
    const backend = new BackendController(options);
    const abort = (): void => {
        void backend.stop();
    };
    options.signal?.addEventListener('abort', abort, {once: true});
    const close = async (): Promise<void> => {
        options.signal?.removeEventListener('abort', abort);
        await backend.stop();
    };
    try {
        options.signal?.throwIfAborted();
        await backend.ready;
        await backend.open(secret);
        secret = undefined;
        const identity = await backend.identity();
        options.signal?.throwIfAborted();
        return {identity, backend, close};
    } catch (error) {
        await close();
        throw error;
    } finally {
        // JS strings cannot be wiped; drop our reference as soon as unlock finishes.
        secret = undefined;
    }
}
