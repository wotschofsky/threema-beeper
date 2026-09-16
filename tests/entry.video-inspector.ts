import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectVideoSource} from '../src/media/video-inspector.ts';
import {parseVideoSourceMetadata} from '../src/media/video-source-metadata.ts';

await test('isolated video inspection enforces read budgets, rejects corruption and supports cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-inspection-'));
    const limiter = process.env.MEDIA_LIMITER_TEST_EXECUTABLE ?? join(directory, 'launcher');
    try {
        if (!process.env.MEDIA_LIMITER_TEST_EXECUTABLE)
            await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        const fixture = JSON.parse(
            await readFile(new URL('./fixtures/video-timelines.json', import.meta.url), 'utf8'),
        ).files[0];
        const bytes = Buffer.from(fixture.bytes, 'base64');
        let reads = 0;
        const source = {
            bytes: bytes.length,
            read: async (start: number, end: number) => {
                reads++;
                return Buffer.from(bytes.subarray(start, end));
            },
        };
        const options = {
            limiter,
            executable: process.execPath,
            cpuSeconds: 5,
            memoryBytes: Number(
                process.env.VIDEO_INSPECTOR_TEST_ADDRESS_SPACE_BYTES ??
                    process.env.MEDIA_TEST_ADDRESS_SPACE_BYTES ??
                    805306368,
            ),
            timeoutMs: 10000,
            maximumDurationSeconds: 3,
            maximumReadBytes: 1048576,
        };
        await assert.rejects(inspectVideoSource(source, {...options, maximumReadBytes: 1}));
        assert.equal(reads, 0, 'Reject over-budget requests before exposing plaintext');
        await assert.rejects(
            inspectVideoSource({...source, read: async () => Buffer.from('bad')}, options),
        );
        await assert.rejects(
            inspectVideoSource(
                {...source, read: async (start, end) => Buffer.alloc(end - start)},
                options,
            ),
        );
        await assert.rejects(
            inspectVideoSource(
                {
                    ...source,
                    read: async () => {
                        throw new Error('Read failed');
                    },
                },
                options,
            ),
        );
        await assert.rejects(inspectVideoSource(source, {...options, maximumDurationSeconds: 1}));
        const controller = new AbortController();
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocked = inspectVideoSource(
            {
                ...source,
                read: async (start, end) => {
                    controller.abort();
                    await wait;
                    return Buffer.from(bytes.subarray(start, end));
                },
            },
            {...options, signal: controller.signal},
        );
        const rejected = assert.rejects(blocked);
        setTimeout(release, 300);
        await rejected;
        await assert.rejects(inspectVideoSource(source, {...options, timeoutMs: 1}));
        const valid = await inspectVideoSource(source, options);
        assert.equal(
            valid.durationSeconds,
            fixture.durationSeconds,
            'A cancelled inspection does not consume or corrupt its source',
        );
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});

await test('inspection protocol rejects invalid child ranges and kills a stalled child', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-protocol-'));
    const limiter = join(directory, 'launcher'),
        executable = join(directory, 'fake-node'),
        pidFile = join(directory, 'pid');
    const options = {
        limiter,
        executable,
        cpuSeconds: 5,
        memoryBytes: 536870912,
        timeoutMs: 3000,
        maximumDurationSeconds: 3,
        maximumReadBytes: 1048576,
    };
    let reads = 0;
    const source = {
        bytes: 100000,
        read: async (start: number, end: number) => {
            reads++;
            return Buffer.alloc(end - start);
        },
    };
    try {
        await writeFile(limiter, '#!/bin/sh\nshift 3\nexec "$@"\n', {mode: 0o700});
        for (const response of [
            {type: 'read', id: 1, start: -1, end: 1},
            {type: 'read', id: 1, start: 0, end: 65537},
            {type: 'read', id: 1, start: 0, end: 100001},
            {type: 'read', id: 2, start: 0, end: 1},
            {type: 'read', id: 1, start: 0, end: 1, path: '/secret'},
            {type: 'result', metadata: {}},
        ]) {
            await writeFile(
                executable,
                `#!${process.execPath}\nprocess.stdin.resume(); process.stdout.write(${JSON.stringify(JSON.stringify(response) + '\n')}); setInterval(() => {}, 1000);`,
                {mode: 0o700},
            );
            await assert.rejects(inspectVideoSource(source, options));
        }
        assert.equal(reads, 0);
        await writeFile(
            executable,
            `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`,
            {mode: 0o700},
        );
        await assert.rejects(inspectVideoSource(source, {...options, timeoutMs: 500}));
        const pid = Number(await readFile(pidFile, 'utf8'));
        assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});

await test('video metadata validates the complete output before codec dispatch', () => {
    const track = {
        index: 0,
        type: 'video',
        codec: 'avc',
        firstTimestamp: 0,
        width: 64,
        height: 48,
        codedWidth: 64,
        codedHeight: 48,
        rotation: 0,
    };
    const valid = {durationSeconds: 1, firstTimestamp: 0, tracks: [track]};
    assert.deepEqual(parseVideoSourceMetadata(valid, 3), valid);
    assert.deepEqual(
        parseVideoSourceMetadata({...valid, thumbnail: {trackIndex: 0, timestamp: 0}}, 3).thumbnail,
        {trackIndex: 0, timestamp: 0},
    );
    for (const thumbnail of [
        {trackIndex: 1, timestamp: 0},
        {trackIndex: 0, timestamp: -1},
        {trackIndex: 0, timestamp: 2},
        {trackIndex: 0, timestamp: NaN},
        {trackIndex: 0, timestamp: 0, token: 'secret'},
    ])
        assert.throws(() => parseVideoSourceMetadata({...valid, thumbnail}, 3));
    for (const mutation of [
        {durationSeconds: Infinity},
        {durationSeconds: 4},
        {firstTimestamp: 1},
        {tracks: []},
        {key: 'secret'},
        {tracks: [{...track, width: 48}]},
        {tracks: [{...track, rotation: 1}]},
        {tracks: [{...track, codec: '../codec'}]},
        {tracks: [{...track, index: 1}]},
        {tracks: [{...track, sampleRate: 48000}]},
    ])
        assert.throws(() => parseVideoSourceMetadata({...valid, ...mutation}, 3));
});
