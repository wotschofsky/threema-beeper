import {recordBackupStatus} from './status.ts';
const [directory, result] = process.argv.slice(2);
if (process.argv.length !== 4 || !directory?.startsWith('/') || (result !== 'success' && result !== 'failed')) {
    process.stderr.write('Usage: node src/backup/entry.status.ts <absolute-state-directory> <success|failed>\n');
    process.exitCode = 2;
} else {
    try { await recordBackupStatus(directory, result); }
    catch {
        process.stderr.write('Could not record backup result. Check maintenance storage and permissions.\n');
        process.exitCode = 1;
    }
}
