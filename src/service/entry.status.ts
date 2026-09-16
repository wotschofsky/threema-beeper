import {resolve} from 'node:path';
import {readServiceConfig} from './config.ts';
import {readRegistration} from './registration.ts';
import {liveStatus} from './live-status.ts';

if (process.argv.length !== 3) {
    process.stderr.write('Usage: pnpm run status <config.yaml>\n');
    process.exitCode = 2;
} else {
    try {
        const config = await readServiceConfig(resolve(process.argv[2]!));
        const {registration} = await readRegistration(config);
        const status = await liveStatus({
            port: config.matrix.port,
            token: registration.getOutput().hs_token,
            owner: config.owner,
            identity: config.identity,
        });
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        if (!status.healthy) process.exitCode = 1;
    } catch {
        process.stderr.write(
            'Unable to verify local status. Check that the service is running with this configuration.\n',
        );
        process.exitCode = 1;
    }
}
