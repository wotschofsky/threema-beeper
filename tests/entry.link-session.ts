import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {LinkSession, type SetupBackend} from '../src/setup/link-session.ts';
import {readProfileSecret} from '../src/setup/profile-secret.ts';
import {linkingEmojis} from '../src/setup/link-emojis.ts';
import {setupAuditLog} from '../src/setup/audit.ts';

type BackendOptions = Parameters<
    NonNullable<ConstructorParameters<typeof LinkSession>[0]['backendFactory']>
>[0];
function fixture(expectedIdentity?: string) {
    const directory = mkdtempSync(join(tmpdir(), 'threema-link-session-'));
    let onState: BackendOptions['onState'];
    let resolveLink!: () => void;
    let rejectLink!: (error: Error) => void;
    const linked = new Promise<void>((resolve, reject) => {
        resolveLink = resolve;
        rejectLink = reject;
    });
    void linked.catch(() => undefined);
    const profileDirectory = join(directory, 'profile');
    const secretFile = join(directory, 'secret');
    let supplied = false;
    const backend: SetupBackend = {
        ready: Promise.resolve(),
        identity: async () => 'TEST1234',
        link: async () => {
            await linked;
        },
        providePassword: async (secret) => {
            assert.ok(
                readProfileSecret(secretFile) === secret,
                'Persist secret before providing it to backend',
            );
            supplied = true;
            resolveLink();
        },
        stop: async () => {
            rejectLink(new Error('synthetic stopped'));
        },
    };
    const audits: string[] = [];
    const session = new LinkSession({
        onAudit: (event) => {
            audits.push(setupAuditLog(event));
        },
        profileDirectory,
        secretFile,
        expectedIdentity,
        wasmFile: resolve('.local/wasm-web/libthreema_bg.wasm'),
        backendFactory: (options) => {
            onState = options.onState;
            return backend;
        },
    });
    return {
        audits,
        directory,
        profileDirectory,
        secretFile,
        session,
        supplied: () => supplied,
        emit: (state: unknown) => {
            onState!('link-state', state);
        },
        cleanup: async () => {
            await session.stop();
            rmSync(directory, {recursive: true, force: true});
        },
    };
}

await test('pairing persists a generated secret before backend use and requires recovery acknowledgement', async () => {
    const f = fixture();
    try {
        const completion = f.session.begin();
        f.emit({state: 'waiting-for-handshake', joinUri: 'threema://device-group/join#synthetic'});
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(f.session.state.state, 'qr');
        assert.equal(existsSync(f.secretFile), false);
        f.emit({state: 'nominated', rph: new Uint8Array([0, 1, 2])});
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(f.session.state, {state: 'confirm', emojis: ['🐵', '🐶', '🐩']});
        f.emit({state: 'waiting-for-password'});
        await completion;
        assert.ok(f.supplied());
        assert.equal(f.session.state.state, 'ready');
        assert.deepEqual(f.session.state, {state: 'ready', identity: 'TEST1234'});
        assert.ok(f.session.recoverySecret() === readProfileSecret(f.secretFile));
        assert.throws(() => f.session.finish(false));
        await assert.rejects(f.session.cancel());
        f.session.finish(true);
        assert.throws(() => f.session.recoverySecret());
        assert.equal(f.session.state.state, 'finished');
        assert.deepEqual(
            f.audits.map((line) => JSON.parse(line).event),
            ['link-started', 'profile-secret-persisted', 'link-ready', 'recovery-acknowledged'],
        );
        const audit = f.audits.join('');
        for (const privateValue of [
            readProfileSecret(f.secretFile),
            'TEST1234',
            'threema://',
            f.profileDirectory,
            '🐵',
        ])
            assert(!audit.includes(privateValue));
        assert.ok(existsSync(f.profileDirectory));
    } finally {
        await f.cleanup();
    }
});

await test('early cancellation removes only the newly owned incomplete profile', async () => {
    const f = fixture();
    try {
        const completion = f.session.begin();
        const failed = assert.rejects(completion);
        await new Promise((resolve) => setImmediate(resolve));
        await f.session.cancel();
        await failed;
        assert.equal(existsSync(f.profileDirectory), false);
        assert.deepEqual(
            f.audits.map((line) => JSON.parse(line).event),
            ['link-started', 'incomplete-profile-removed', 'link-cancelled'],
        );
        assert.equal(existsSync(f.secretFile), false);
        assert.equal(f.session.state.state, 'cancelled');
    } finally {
        await f.cleanup();
    }
});

await test('setup refuses existing profiles and cannot delete them on cancellation', async () => {
    const f = fixture();
    mkdirSync(f.profileDirectory);
    try {
        await assert.rejects(f.session.begin());
        await f.session.cancel();
        assert.ok(existsSync(f.profileDirectory));
    } finally {
        await f.cleanup();
    }
});

await test('emoji mapping uses upstream indices and rejects incomplete hashes', () => {
    assert.deepEqual(linkingEmojis(new Uint8Array([0, 128, 255])), ['🐵', '🐵', '👣']);
    assert.throws(() => linkingEmojis(new Uint8Array([1, 2])));
});

await test('configured setup identity mismatch preserves registered profile and secret', async () => {
    const f = fixture('OTHER123');
    try {
        const completion = f.session.begin();
        const rejected = assert.rejects(completion, /Local setup failed/);
        f.emit({state: 'waiting-for-password'});
        await rejected;
        assert.equal(f.session.state.state, 'error');
        assert(existsSync(f.profileDirectory));
        assert(existsSync(f.secretFile));
        assert.throws(() => f.session.recoverySecret());
        assert.deepEqual(
            f.audits.map((line) => JSON.parse(line).event),
            ['link-started', 'profile-secret-persisted', 'link-failed'],
        );
    } finally {
        await f.cleanup();
    }
});
await test('configured setup identity matches the linked identity', async () => {
    const f = fixture('TEST1234');
    try {
        const completion = f.session.begin();
        f.emit({state: 'waiting-for-password'});
        await completion;
        assert.equal(f.session.state.state, 'ready');
        f.session.finish(true);
    } finally {
        await f.cleanup();
    }
});
