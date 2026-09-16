import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, readFile, writeFile, chmod, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseServiceConfig} from '../src/service/config.ts';
import {exportProxyRegistration} from '../src/service/proxy-registration.ts';
import {validateProxyCredentials} from '../src/service/proxy-credentials.ts';
import {prepareProxy} from '../src/service/proxy.ts';
import {registrationDoctor} from '../src/service/registration-doctor.ts';

await test('proxy preparation requires matching private registrations, explicit credentials and pinned executable', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'proxy-prepare-')));
    const binary = join(directory, 'binary');
    const binaryBytes = Buffer.from('not executed: synthetic bbctl fixture');
    const sha256 = createHash('sha256').update(binaryBytes).digest('hex');
    const configFile = join(directory, 'auth.json');
    const registrationFile = join(directory, 'proxy.yaml');
    const example = await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8');
    const yaml =
        example +
        `  proxy:\n    binary: ${binary}\n    sha256: ${sha256}\n    config_file: ${configFile}\n    registration_file: ${registrationFile}\n`;
    const config = parseServiceConfig(yaml);
    config.owner = '@owner:beeper.com';
    config.matrix.domain = 'beeper.local';
    config.matrix.namespace = 'sh-threema';
    config.matrix.homeserver = 'https://matrix.beeper.com/_hungryserv/owner';
    config.matrix.registrationFile = join(directory, 'source.yaml');
    const source = `id: sh-threema\nurl: http://127.0.0.1:29339\nas_token: synthetic-as\nhs_token: synthetic-hs\nsender_localpart: bridge_bot\nnamespaces:\n  users:\n    - regex: '^@threema_.*:example.invalid$'\n      exclusive: true\n`;
    try {
        assert.deepEqual(config.proxy, {binary, sha256, configFile, registrationFile});
        assert.throws(() => parseServiceConfig(yaml.replace(sha256, 'not-a-pin')));
        assert.throws(() => parseServiceConfig(yaml.replace('    binary:', '    unknown:')));
        await writeFile(binary, binaryBytes, {mode: 0o700});
        const credentials = {
            device_id: 'bbctl_fixture',
            environments: {
                prod: {
                    username: 'owner',
                    access_token: 'syt_synthetic-fixture',
                    bridge_data_dir: directory,
                },
            },
        };
        await writeFile(configFile, JSON.stringify(credentials), {mode: 0o600});
        for (const change of [
            {username: 'other'},
            {username: ''},
            {access_token: ''},
            {access_token: 'wrong'},
            {desktop_data_dir: '/personal/beeper'},
            {bridge_data_dir: ''},
        ])
            assert.throws(
                () =>
                    validateProxyCredentials(
                        JSON.stringify({
                            ...credentials,
                            environments: {prod: {...credentials.environments.prod, ...change}},
                        }),
                        config,
                    ),
                {message: 'Invalid private bbctl credentials'},
            );
        assert.throws(() =>
            validateProxyCredentials(JSON.stringify(credentials), {
                ...config,
                owner: '@owner:other.invalid',
            }),
        );
        assert.throws(() =>
            validateProxyCredentials(JSON.stringify(credentials), {
                ...config,
                matrix: {...config.matrix, homeserver: 'https://other.invalid'},
            }),
        );
        assert.throws(() =>
            validateProxyCredentials(
                JSON.stringify(credentials).replace(
                    '"username":"owner"',
                    '"username":"other","username":"owner"',
                ),
                config,
            ),
        );
        await writeFile(config.matrix.registrationFile, source, {mode: 0o600});
        await exportProxyRegistration(config, registrationFile);
        const diagnostics = await registrationDoctor(config);
        assert.equal(
            diagnostics.find((check) => check.name === 'proxy-configuration')?.status,
            'pass',
        );
        assert(!JSON.stringify(diagnostics).includes('synthetic-as'));
        const proxy = await prepareProxy(config);
        assert.equal(proxy.state, 'idle', 'Preparation must not execute the binary');
        await proxy.stop();
        await chmod(configFile, 0o644);
        await assert.rejects(prepareProxy(config));
        await chmod(configFile, 0o600);
        await writeFile(registrationFile, source.replace('synthetic-as', 'different-as'));
        await assert.rejects(prepareProxy(config));
        await writeFile(registrationFile, source);
        await assert.rejects(prepareProxy(config, AbortSignal.abort()));
        await writeFile(binary, 'changed executable');
        await assert.rejects(prepareProxy(config));
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
