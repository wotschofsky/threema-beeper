import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';

const backend: {
    probe(wasm: string, profile: string): Promise<unknown>;
    createNodeSession(
        profile: string,
        onLink: (state: {state: string; type?: {kind: string}}) => void,
        onLoad: () => void,
    ): {
        link(): Promise<void>;
        providePassword(secret: string): void;
        closeEndpoints(): void;
    };
} = createRequire(import.meta.url)(
    '../../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);

await test(
    'real device join reaches the WebSocket boundary and propagates connection failure',
    {timeout: 15000},
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'threema-link-boundary-'));
        const original = globalThis.WebSocket;
        let attempts = 0;
        const states: {state: string; type?: {kind: string}}[] = [];
        let session: ReturnType<typeof backend.createNodeSession> | undefined;
        try {
            await backend.probe(resolve('.local/wasm-web/libthreema_bg.wasm'), directory);
            // Only the WebSocket constructor is replaced. No connection is made to a real service.
            Object.defineProperty(globalThis, 'WebSocket', {
                configurable: true,
                writable: true,
                value: class {
                    constructor() {
                        attempts++;
                        throw new Error('synthetic network unavailable');
                    }
                },
            });
            session = backend.createNodeSession(
                directory,
                (state) => {
                    states.push(state);
                },
                () => undefined,
            );
            await assert.rejects(session.link(), {type: 'handled-linking-error'});
            assert.equal(attempts, 1);
            assert.ok(
                states.some(
                    (state) => state.state === 'error' && state.type?.kind === 'connection-error',
                ),
            );
            assert.throws(() =>
                session!.providePassword('synthetic-generated-secret-with-enough-length'),
            );
        } finally {
            session?.closeEndpoints();
            Object.defineProperty(globalThis, 'WebSocket', {
                configurable: true,
                writable: true,
                value: original,
            });
            rmSync(directory, {recursive: true, force: true});
        }
    },
);
