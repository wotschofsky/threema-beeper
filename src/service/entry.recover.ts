import {resolve} from 'node:path';
import {readServiceConfig} from './config.ts';
import {readRegistration} from './registration.ts';
const [file, action = 'status'] = process.argv.slice(2);
if (!file || process.argv.length > 4 || !['status', 'resync', 'retry'].includes(action)) {
    process.stderr.write('Usage: pnpm run recover <config.yaml> [status|resync|retry]\n');
    process.exitCode = 2;
} else
    try {
        const config = await readServiceConfig(resolve(file)),
            {registration} = await readRegistration(config);
        const response = await fetch(`http://127.0.0.1:${config.matrix.port}/_threema/recovery`, {
            method: action === 'status' ? 'GET' : 'POST',
            headers: {
                'Authorization': 'Bearer ' + registration.getHomeserverToken(),
                'Content-Type': 'application/json',
            },
            ...(action === 'status' ? {} : {body: JSON.stringify({action})}),
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error('Recovery unavailable');
        const body = await response.text();
        if (body.length > 65536) throw Error('Oversized recovery status');
        const result = JSON.parse(body);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch {
        process.stderr.write(
            'Cannot reach the running bridge. Check its service status and configuration. No queued messages were changed by this command unless the service accepted a retry request.\n',
        );
        process.exitCode = 1;
    }
