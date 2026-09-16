import {isAbsolute} from 'node:path';
import {parseSecurityScan, type SecurityScan} from '../operations/security-scan.ts';
import {recordSecurityScan} from '../operations/security-scan-store.ts';

const [directory, result] = process.argv.slice(2);
if (process.argv.length !== 4 || !directory || !isAbsolute(directory) ||
    !(result === 'failed' || /^sha256:[a-f0-9]{64}$/.test(result ?? ''))) {
    process.stderr.write('Usage: node src/service/entry.security-scan-result.ts <absolute-state-directory> <failed|image-id>\nA successful Grype JSON report is read from stdin.\n');
    process.exitCode = 2;
} else {
    let scan: SecurityScan | undefined;
    let invalid = false;
    if (result !== 'failed') {
        try {
            const chunks: Buffer[] = [];
            let length = 0;
            for await (const raw of process.stdin) {
                const chunk = Buffer.from(raw);
                length += chunk.length;
                if (length > 128 * 1024 * 1024) throw new Error('Scan report too large');
                chunks.push(chunk);
            }
            scan = parseSecurityScan(JSON.parse(Buffer.concat(chunks).toString('utf8')), result!);
        } catch { invalid = true; }
    }
    try {
        await recordSecurityScan(directory, scan);
        if (invalid) {
            process.stderr.write('Scan report rejected. Failure recorded; previous successful findings preserved.\n');
            process.exitCode = 1;
        }
    } catch {
        process.stderr.write('Could not record scan result. Check maintenance storage, state integrity and concurrent jobs.\n');
        process.exitCode = 1;
    }
}
