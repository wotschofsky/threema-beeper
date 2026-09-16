import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
    mkdtemp,
    realpath,
    readFile,
    writeFile,
    stat,
    readdir,
    chmod,
    symlink,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseServiceConfig} from '../src/service/config.ts';
import {parseRegistration} from '../src/service/registration.ts';
import {exportProxyRegistration} from '../src/service/proxy-registration.ts';

await test('proxy export publishes complete private YAML and never replaces existing files or symlinks', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'threema-proxy-export-')));
    const source = join(directory, 'bbctl.json');
    const destination = join(directory, 'proxy.yaml');
    const config = parseServiceConfig(
        await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8'),
    );
    config.matrix.registrationFile = source;
    const envelope = {
        your_user_id: config.owner,
        homeserver_domain: config.matrix.domain,
        homeserver_url: config.matrix.homeserver,
        registration: {
            id: 'sh-threema',
            url: 'websocket',
            as_token: 'synthetic-as',
            hs_token: 'synthetic-hs',
            sender_localpart: 'bridge_bot',
            namespaces: {
                users: [{regex: '^@threema_.*:example\\.invalid$', exclusive: true}],
                aliases: [],
                rooms: [],
            },
        },
    };
    try {
        await writeFile(source, JSON.stringify(envelope), {mode: 0o600});
        await exportProxyRegistration(config, destination);
        assert.equal((await stat(destination)).mode & 0o777, 0o600);
        const yaml = await readFile(destination, 'utf8');
        const parsed = parseRegistration(yaml, config);
        assert.equal(parsed.registration.getOutput().url, 'http://127.0.0.1:29339');
        assert.equal(parsed.registration.getAppServiceToken(), 'synthetic-as');
        assert.equal(parsed.registration.getHomeserverToken(), 'synthetic-hs');
        assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), envelope);
        await assert.rejects(exportProxyRegistration(config, destination), {
            message: 'Unable to export private proxy registration',
        });
        assert.equal(await readFile(destination, 'utf8'), yaml);
        const link = join(directory, 'link.yaml');
        await symlink(source, link);
        await assert.rejects(exportProxyRegistration(config, link));
        assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), envelope);
        await chmod(directory, 0o755);
        await assert.rejects(exportProxyRegistration(config, join(directory, 'public.yaml')));
        await chmod(directory, 0o700);
        // Concurrent exports have exactly one winner and leave no incomplete artifact.
        const raced = join(directory, 'raced.yaml');
        const results = await Promise.allSettled([
            exportProxyRegistration(config, raced),
            exportProxyRegistration(config, raced),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(await readFile(raced, 'utf8'), yaml);
        assert.deepEqual((await readdir(directory)).sort(), [
            'bbctl.json',
            'link.yaml',
            'proxy.yaml',
            'raced.yaml',
        ]);
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
