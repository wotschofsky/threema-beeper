import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ProcessSupervisor, type ProcessState} from '../src/service/process-supervisor.ts';

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 500; i++) {
        if (await predicate()) return;
        await delay(5);
    }
    throw new Error('Fixture did not reach expected state');
}
await test(
    'supervisor restarts failed children but leaves clean exits terminal',
    {timeout: 5000},
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'threema-supervisor-'));
        const file = join(directory, 'attempts');
        const states: ProcessState[] = [];
        const supervisor = new ProcessSupervisor({
            executable: process.execPath,
            env: {},
            retryMs: 5,
            maxRetryMs: 10,
            args: [
                '--input-type=module',
                '-e',
                `import {appendFileSync,readFileSync} from 'node:fs'; appendFileSync(process.argv[1],'x'); process.exit(readFileSync(process.argv[1]).length < 3 ? 1 : 0);`,
                file,
            ],
            onState: (state) => {
                states.push(state);
                if (state === 'running') throw new Error('observer failure');
            },
        });
        try {
            supervisor.start();
            await until(() => supervisor.state === 'stopped');
            assert.equal(await readFile(file, 'utf8'), 'xxx');
            assert.equal(states.filter((s) => s === 'running').length, 3);
            assert.equal(states.filter((s) => s === 'backoff').length, 2);
            await Promise.all([supervisor.stop(), supervisor.stop()]);
            assert.throws(() => supervisor.start(), /already used/);
        } finally {
            await supervisor.stop();
            await rm(directory, {recursive: true, force: true});
        }
    },
);
await test(
    'stop escalates for an uncooperative child and waits for its exit',
    {timeout: 5000},
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'threema-supervisor-stop-'));
        const file = join(directory, 'pid');
        const supervisor = new ProcessSupervisor({
            executable: process.execPath,
            env: {},
            stopTimeoutMs: 20,
            args: [
                '--input-type=module',
                '-e',
                `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},100);`,
                file,
            ],
        });
        try {
            supervisor.start();
            await until(async () => {
                try {
                    await readFile(file);
                    return true;
                } catch {
                    return false;
                }
            });
            const pid = Number(await readFile(file, 'utf8'));
            await supervisor.stop();
            assert.equal(supervisor.state, 'stopped');
            assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
        } finally {
            await supervisor.stop();
            await rm(directory, {recursive: true, force: true});
        }
    },
);
await test(
    'missing executable enters interruptible backoff without an unhandled error',
    {timeout: 5000},
    async () => {
        const supervisor = new ProcessSupervisor({
            executable: '/nonexistent/threema-fixture',
            args: [],
            env: {},
            retryMs: 60000,
        });
        supervisor.start();
        await until(() => supervisor.state === 'backoff');
        await supervisor.stop();
        assert.equal(supervisor.state, 'stopped');
    },
);

await test(
    'failed checksum prevents child launch and stop interrupts verification retry',
    {timeout: 5000},
    async () => {
        let launched = false;
        const supervisor = new ProcessSupervisor({
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            env: {},
            sha256: '0'.repeat(64),
            retryMs: 60000,
            onState: (state) => {
                if (state === 'running') launched = true;
            },
        });
        try {
            supervisor.start();
            await until(() => supervisor.state === 'backoff');
            assert.equal(launched, false);
        } finally {
            await supervisor.stop();
        }
    },
);
