import {statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

// Node's test runner silently ignores some nonexistent explicit paths. Validate the
// complete requested set before executing any test, including staged/container runs.
const files = process.argv.slice(2);
if (!files.length) throw new Error('At least one explicit test file is required');
for (const filename of files) {
    if (filename.startsWith('-') || !/\.(?:[cm]?[jt]s)$/.test(filename))
        throw new Error('Expected an explicit JavaScript or TypeScript test file: ' + filename);
    let regular = false;
    try {
        regular = statSync(filename).isFile();
    } catch {}
    if (!regular)
        throw new Error('Requested test file is missing or not a regular file: ' + filename);
}
const env = {...process.env};
delete env.NODE_TEST_CONTEXT;
const child = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...files], {
    stdio: 'inherit',
    env,
});
if (child.error) throw child.error;
if (child.signal) {
    process.kill(process.pid, child.signal);
} else process.exitCode = child.status ?? 1;
