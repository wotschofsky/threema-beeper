import {sourceVersion} from './version.ts';
if (process.argv.length !== 3 || process.argv[2] !== '--json') {
    process.stderr.write('Usage: pnpm run version --json\n');
    process.exitCode = 2;
} else {
    try {
        process.stdout.write(JSON.stringify(await sourceVersion(), null, 2) + '\n');
    } catch {
        process.stderr.write('Unable to read source version manifest.\n');
        process.exitCode = 1;
    }
}
