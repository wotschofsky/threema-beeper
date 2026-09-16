import type {ServiceConfig} from './config.ts';
import {readRegistration} from './registration.ts';
import {prepareProxy} from './proxy.ts';
import {privacyDoctor} from './privacy-doctor.ts';

export async function registrationDoctor(config: ServiceConfig) {
    const checks: {name: string; status: 'pass' | 'fail' | 'unknown'; detail: string}[] = [];
    const metadata = await privacyDoctor(config);
    const safe = (role: string) =>
        metadata.paths.find((path) => path.role === role)?.status === 'private';
    if (!safe('appservice-registration'))
        checks.push({
            name: 'appservice-registration',
            status: 'unknown',
            detail: 'Skipped because registration metadata is not private and owned.',
        });
    else {
        try {
            await readRegistration(config);
            checks.push({
                name: 'appservice-registration',
                status: 'pass',
                detail: 'Local registration matches configured listener, namespaces and owner routing. Remote registration is not verified.',
            });
        } catch {
            checks.push({
                name: 'appservice-registration',
                status: 'fail',
                detail: 'Local appservice registration is invalid or incompatible with configuration.',
            });
        }
    }
    if (!config.proxy)
        checks.push({
            name: 'proxy-configuration',
            status: 'unknown',
            detail: 'No managed proxy configured.',
        });
    else if (!['appservice-registration', 'proxy-credentials', 'proxy-registration'].every(safe))
        checks.push({
            name: 'proxy-configuration',
            status: 'unknown',
            detail: 'Skipped because explicit proxy credential or registration metadata is unsafe.',
        });
    else {
        try {
            // Preparation validates explicit files and creates an idle supervisor only.
            // Never call start(): no executable, account request or credential discovery.
            const proxy = await prepareProxy(config);
            if (proxy.state !== 'idle') throw new Error();
            await proxy.stop();
            checks.push({
                name: 'proxy-configuration',
                status: 'pass',
                detail: 'Explicit credentials, matching registrations and executable checksum passed local validation; proxy was not started.',
            });
        } catch {
            checks.push({
                name: 'proxy-configuration',
                status: 'fail',
                detail: 'Explicit proxy credentials, registration consistency or executable validation failed.',
            });
        }
    }
    return checks;
}
