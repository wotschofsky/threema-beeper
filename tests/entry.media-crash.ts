import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {appendFileSync, closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {OutboxStore} from '../src/outbox/store.ts';
import {MediaDispatcher} from '../src/outbox/media-dispatcher.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';

const kinds = ['m.file', 'm.image', 'm.audio', 'm.video'] as const;
const points = ['before-prepare', 'prepared', 'preparing', 'claimed', 'allocated',
    'first-effect', 'all-effects', 'echo-before-result', 'sent', 'echo-after-result'] as const;
const ids = ['m:0100000000000000', 'm:0200000000000000'];
function request(kind: typeof kinds[number]): MediaRequest {
    return {id: '01900000-0000-7000-8000-000000000001', profile: 'SELF1234',
        event: '$media-crash', room: '!room:invalid', owner: '@owner:invalid', transaction: 'fixture',
        media: {chat: 'c:TEST1234', kind, filename: 'fixture.bin', mimeType: 'application/octet-stream', bytes: 12,
            file: {url: 'mxc://invalid/fixture', v: 'v2',
                key: {kty: 'oct', alg: 'A256CTR', key_ops: ['decrypt'], k: Buffer.alloc(32).toString('base64url')},
                iv: Buffer.alloc(16).toString('base64'), hashes: {sha256: Buffer.alloc(32).toString('base64')}}}};
}
function effects(directory: string): string[] {
    const path = join(directory, 'effects');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}
function effect(directory: string, id: string): void {
    const fd = openSync(join(directory, 'effects'), 'a', 0o600);
    try { appendFileSync(fd, id + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
function dispatcher(store: OutboxStore, value: MediaRequest, directory: string,
    checkpoint: (point: string) => Promise<void>, earlyEcho = false): MediaDispatcher {
    const command = {profile: value.profile, chatId: value.media.chat, token: 'a'.repeat(64), fileName: 'fixture.bin', mediaType: 'application/octet-stream'};
    const discard = async () => {};
    const send = async (_command: unknown, persist: (ids: readonly string[]) => Promise<void>) => {
        await checkpoint('claimed');
        await persist(ids);
        await checkpoint('allocated');
        effect(directory, ids[0]!);
        await checkpoint('first-effect');
        effect(directory, ids[1]!);
        await checkpoint('all-effects');
        if (earlyEcho) {
            for (const id of [...ids].reverse()) store.media.observe(value.profile, value.media.chat, id);
            await checkpoint('echo-before-result');
        }
        return ids;
    };
    return new MediaDispatcher({profile: value.profile, journal: store.media, ready: () => true,
        authorize: async () => {},
        prepare: async () => { await checkpoint('preparing'); return {request: command, discard}; },
        backend: {sendPreparedFile: send},
        images: {send, prepare: async () => {
            await checkpoint('preparing');
            const metadata = {fileName: 'fixture.png', mediaType: 'image/png' as const, width: 2, height: 2,
                thumbnailMediaType: 'image/png' as const, thumbnailWidth: 1, thumbnailHeight: 1};
            return {request: {...command, ...metadata, thumbnailToken: 'b'.repeat(64)},
                projection: {kind: 'image', ...metadata, bytes: 12, thumbnailBytes: 6}, discard};
        }},
        audio: {prepare: async () => {
            await checkpoint('preparing');
            return {request: {...command, fileName: 'fixture.m4a', mediaType: 'audio/mp4', audioDurationSeconds: 1},
                projection: {kind: 'audio', fileName: 'fixture.m4a', mediaType: 'audio/mp4', durationSeconds: 1, bytes: 12}, discard};
        }},
        videos: {send, prepare: async () => {
            await checkpoint('preparing');
            const metadata = {fileName: 'fixture.mp4', mediaType: 'video/mp4' as const, width: 2, height: 2, durationSeconds: 1};
            return {request: {...command, ...metadata}, projection: {kind: 'video', ...metadata, bytes: 12}, discard};
        }},
    });
}
if (process.argv[2] === '--child') {
    const directory = process.argv[3]!, point = process.argv[4]!;
    const value = request(process.argv[5] as typeof kinds[number]);
    const store = new OutboxStore(join(directory, 'outbox'), readFileSync(join(directory, 'key')));
    const checkpoint = async (name: string) => {
        if (name !== point) return;
        process.send?.({point: name});
        await new Promise<void>(() => { setInterval(() => {}, 1000); });
    };
    await checkpoint('before-prepare');
    store.media.prepare(value);
    await checkpoint('prepared');
    await dispatcher(store, value, directory, checkpoint, point === 'echo-before-result').drain();
    await checkpoint('sent');
    for (const id of ids) store.media.observe(value.profile, value.media.chat, id);
    await checkpoint('echo-after-result');
    throw new Error('Invalid media checkpoint');
} else for (const kind of kinds) await test(`SIGKILL media ${kind} boundaries preserve uncertain sends`, {timeout: 90_000}, async context => {
    for (const point of points) {
        const directory = mkdtempSync(join(tmpdir(), 'media-kill-')), key = randomBytes(32), value = request(kind);
        let child: ReturnType<typeof fork> | undefined, exited: Promise<unknown[]> | undefined, store: OutboxStore | undefined;
        try {
            writeFileSync(join(directory, 'key'), key, {mode: 0o400, flag: 'wx'});
            child = fork(fileURLToPath(import.meta.url), ['--child', directory, point, kind], {execPath: process.execPath, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
            exited = once(child, 'exit');
            const [reported] = await Promise.race([once(child, 'message', {signal: context.signal}),
                exited.then(() => { throw new Error(`Child exited before ${kind}/${point}`); })]);
            assert.deepEqual(reported, {point});
            assert(child.kill('SIGKILL'));
            assert.equal((await exited)[1], 'SIGKILL');
            store = new OutboxStore(join(directory, 'outbox'), key);
            store.media.recoverInterrupted();
            const safe = ['before-prepare', 'prepared', 'preparing'].includes(point);
            if (point === 'before-prepare') assert.equal(store.media.get(value.profile, value.event), undefined);
            store.media.prepare(value); // Replayed Matrix event must not reset uncertain work.
            const state = () => store!.media.get(value.profile, value.event)!.state;
            assert.equal(state(), safe ? 'PREPARED' : ['echo-before-result', 'echo-after-result'].includes(point) ? 'SENT' : 'OUTCOME_UNKNOWN', point);
            let invocations = 0;
            const worker = dispatcher(store, value, directory, async name => { if (name === 'claimed') invocations++; });
            assert.equal(await worker.drain(), safe ? 1 : 0);
            assert.equal(invocations, safe ? 1 : 0);
            const observed = effects(directory);
            const expected = safe || ['all-effects', 'echo-before-result', 'sent', 'echo-after-result'].includes(point) ? 2 : point === 'first-effect' ? 1 : 0;
            assert.equal(observed.length, expected, point);
            assert.equal(new Set(observed).size, observed.length, 'Duplicate synthetic recipient effect');
            for (const id of [...observed].reverse()) {
                store.media.observe(value.profile, value.media.chat, id);
                store.media.observe(value.profile, value.media.chat, id);
            }
            assert.equal(state(), observed.length === 2 ? 'SENT' : 'OUTCOME_UNKNOWN');
            assert.equal(await worker.drain(), 0);
            assert.equal(invocations, safe ? 1 : 0);
            context.diagnostic(`${kind}/${point}: no duplicate automatic effect`);
        } finally {
            if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            if (exited) await exited;
            store?.close(); key.fill(0); rmSync(directory, {recursive: true, force: true});
        }
    }
});
