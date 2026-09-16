import {resolve} from 'node:path';
import {readServiceConfig} from './config.ts';
import {readRegistration} from './registration.ts';
import {liveStatus} from './live-status.ts';
import {heartbeat, readHeartbeatUrl} from '../operations/heartbeat.ts';

if (process.argv.length !== 4) {
    process.stderr.write('Usage: node src/service/entry.heartbeat.ts <config.yaml> <private-ping-url-file>\n');
    process.exitCode = 2;
} else {
    try {
        const config = await readServiceConfig(resolve(process.argv[2]!));
        const url = await readHeartbeatUrl(resolve(process.argv[3]!));
        const {registration} = await readRegistration(config);
        const result = await heartbeat(url, () => liveStatus({
            port: config.matrix.port, token: registration.getOutput().hs_token,
            owner: config.owner, identity: config.identity,
        }));
        // Fixed output only: neither provider response bodies nor secret URLs are logged.
        process.stdout.write(JSON.stringify({heartbeat: result}) + '\n');
        if (result !== 'sent') process.exitCode = 1;
    } catch {
        process.stderr.write('Heartbeat unavailable. Check private configuration and local service health.\n');
        process.exitCode = 1;
    }
}
