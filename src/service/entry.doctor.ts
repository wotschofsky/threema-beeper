import {resolve} from 'node:path';
import {readServiceConfig} from './config.ts';
import {privacyDoctor} from './privacy-doctor.ts';

const privacyOnly = process.argv.length === 4 && process.argv[2] === '--privacy';
const local = process.argv.length === 3 && !process.argv[2]!.startsWith('-');
if (!privacyOnly && !local) {
    process.stderr.write('Usage: pnpm run doctor [--privacy] <config.yaml>\n');
    process.exitCode = 2;
} else {
    try {
        const config = await readServiceConfig(resolve(process.argv[privacyOnly ? 3 : 2]!));
        const report = privacyOnly
            ? await privacyDoctor(config)
            : await (await import('./local-doctor.ts')).localDoctor(config);
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        if ('permissionsHealthy' in report ? !report.permissionsHealthy : !report.healthy)
            process.exitCode = 1;
    } catch {
        process.stderr.write('Unable to inspect privacy configuration.\n');
        process.exitCode = 1;
    }
}
