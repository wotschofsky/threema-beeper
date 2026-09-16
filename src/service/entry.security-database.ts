import {assertFreshSecurityDatabase} from '../operations/security-database.ts';
try {
    if (process.argv.length !== 2) throw new Error('Unexpected arguments');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of process.stdin) {
        const chunk = Buffer.from(raw);
        size += chunk.length;
        if (size > 65536) throw new Error('Database status too large');
        chunks.push(chunk);
    }
    assertFreshSecurityDatabase(JSON.parse(Buffer.concat(chunks).toString('utf8')));
} catch {
    process.stderr.write('Scanner database is invalid or older than seven days. Refresh it and retry.\n');
    process.exitCode = 1;
}
