import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {parseServiceConfig} from '../src/service/config.ts';
import {startService} from '../src/service/start.ts';
import {openBridgeResources} from '../src/service/resources.ts';
import {generateProfileSecret, saveProfileSecret} from '../src/setup/profile-secret.ts';

await test(
    'service startup rejects a missing identity without relinking and releases every opened store and worker',
    {timeout: 15_000},
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'threema-service-start-'));
        const example = await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8');
        const config = parseServiceConfig(
            example
                .replaceAll('/data', directory)
                .replace('/run/secrets/matrix_crypto_store_key', join(directory, 'master.key'))
                .replace('/run/secrets/threema_profile_password', join(directory, 'profile.key'))
                .replace('/app/libthreema_bg.wasm', resolve('.local/wasm-web/libthreema_bg.wasm')),
        );
        saveProfileSecret(config.matrix.cryptoKeyFile, generateProfileSecret());
        saveProfileSecret(config.passwordFile, generateProfileSecret());
        config.matrix.registrationFile = join(directory, 'registration.yaml');
        await writeFile(
            config.matrix.registrationFile,
            `id: fixture
url: http://127.0.0.1:29339
as_token: synthetic-private-as-token
hs_token: synthetic-private-hs-token
sender_localpart: bridge_bot
namespaces:
  users:
    - regex: '^@threema_.*:example\\.invalid$'
      exclusive: true
`,
            {mode: 0o600},
        );
        try {
            await assert.rejects(startService(config), {
                message:
                    'Service startup failed; verify configuration, registration and existing profile',
            });
            const resources = openBridgeResources(config);
            assert.equal(resources.inbox.next(), undefined);
            resources.close();
            // A second startup must reach the same failure, rather than a leaked ownership lock.
            await assert.rejects(startService(config), {
                message:
                    'Service startup failed; verify configuration, registration and existing profile',
            });
            const again = openBridgeResources(config);
            again.close();
            const abort = new AbortController();
            abort.abort();
            await assert.rejects(startService(config, abort.signal), {
                message:
                    'Service startup failed; verify configuration, registration and existing profile',
            });
        } finally {
            await rm(directory, {recursive: true, force: true});
        }
    },
);
