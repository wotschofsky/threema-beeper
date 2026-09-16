import {retainBackups} from './retention.ts';
const [directory, newest, keep] = process.argv.slice(2);
if (process.argv.length !== 5 || !directory || !newest || !keep || !/^[1-9]\d{0,3}$/u.test(keep)) {
    process.stderr.write('Usage: node src/backup/entry.retention.ts <absolute-directory> <newly-created-archive-name> <keep-count>\n');
    process.exitCode = 2;
} else {
    try {
        const removed = await retainBackups(directory, newest, Number(keep));
        process.stdout.write(JSON.stringify({backupRetention: 'complete', removed}) + '\n');
    } catch {
        process.stderr.write('Backup retention stopped. Check the private directory and completed backup files.\n');
        process.exitCode = 1;
    }
}
