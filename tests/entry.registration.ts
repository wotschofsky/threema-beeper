import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, chmod, symlink, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {parseServiceConfig} from '../src/service/config.ts';
import {parseRegistration, readRegistration} from '../src/service/registration.ts';
import {registrationDoctor} from '../src/service/registration-doctor.ts';
const config = parseServiceConfig(
    await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8'),
);
const source = `id: sh-threema
url: http://127.0.0.1:29339
as_token: synthetic-private-as-token
hs_token: synthetic-private-hs-token
sender_localpart: bridge_bot
rate_limited: false
de.sorunome.msc2409.push_ephemeral: true
namespaces:
  users:
    - regex: '^@threema_.*:example\\.invalid$'
      exclusive: true
  aliases: []
  rooms: []
`;
await test('registration loader creates the pinned framework registration with exact credentials and listener', () => {
    const result = parseRegistration(source, config);
    assert.equal(result.domain, 'example.invalid');
    assert.equal(result.botUserId, '@bridge_bot:example.invalid');
    assert.equal(result.registration.getAppServiceToken(), 'synthetic-private-as-token');
    assert.equal(result.registration.getHomeserverToken(), 'synthetic-private-hs-token');
    assert.equal(result.registration.getOutput().url, 'http://127.0.0.1:29339');
    assert.equal(result.registration.pushEphemeral, true);
});
await test('registration errors reject mismatched listeners, malformed namespace and YAML without leaking tokens', () => {
    const invalid = [
        source.replace('127.0.0.1', '0.0.0.0'),
        source.replace('29339', '29340'),
        source.replace('http://127.0.0.1:29339', 'http://user:secret@127.0.0.1:29339'),
        source.replace('http://127.0.0.1:29339', 'http://127.0.0.1:29339/path'),
        source.replace('synthetic-private-hs-token', 'synthetic-private-as-token'),
        source.replace('sender_localpart: bridge_bot', 'sender_localpart: owner'),
        source.replace('exclusive: true', 'exclusive: "true"'),
        source.replace("'^@threema_.*:example\\.invalid$'", "'^@.*:example\\.invalid$'"),
        source.replace("'^@threema_.*:example\\.invalid$'", "'['"),
        source + 'id: duplicate\n',
        source
            .replace(
                'as_token: synthetic-private-as-token',
                'as_token: &token synthetic-private-as-token',
            )
            .replace('hs_token: synthetic-private-hs-token', 'hs_token: *token'),
        'x'.repeat(65537),
    ];
    for (const value of invalid)
        assert.throws(() => parseRegistration(value, config), {
            message: 'Invalid appservice registration',
        });
});
await test('registration file requires private permissions and refuses symlinks', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'threema-registration-')));
    const filename = join(directory, 'registration.yaml');
    const options = {...config, matrix: {...config.matrix, registrationFile: filename}};
    try {
        await writeFile(filename, source, {mode: 0o600});
        assert.equal((await readRegistration(options)).botUserId, '@bridge_bot:example.invalid');
        const diagnostics = await registrationDoctor(options);
        assert.equal(
            diagnostics.find((check) => check.name === 'appservice-registration')?.status,
            'pass',
        );
        assert(!JSON.stringify(diagnostics).includes('synthetic-private'));
        await writeFile(filename, source.replace('29339', '29340'));
        assert.equal((await registrationDoctor(options))[0]?.status, 'fail');
        await writeFile(filename, source);
        await chmod(filename, 0o644);
        await assert.rejects(readRegistration(options), {
            message: 'Unable to load private appservice registration',
        });
        await chmod(filename, 0o600);
        const link = join(directory, 'link');
        await symlink(filename, link);
        await assert.rejects(
            readRegistration({...options, matrix: {...options.matrix, registrationFile: link}}),
            {message: 'Unable to load private appservice registration'},
        );
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});

await test('registration uses the configured appservice domain independently of the owner MXID', () => {
    const result = parseRegistration(source, {
        ...config,
        matrix: {...config.matrix, domain: 'beeper.local'},
    });
    assert.equal(result.domain, 'beeper.local');
    assert.equal(result.botUserId, '@bridge_bot:beeper.local');
    assert.notEqual(result.botUserId.split(':')[1], config.owner.split(':')[1]);
});

await test('bbctl JSON metadata is verified before adapting its WebSocket registration', () => {
    const registration = parseRegistration(source, config).registration.getOutput();
    const envelope = {
        registration: {...registration, url: 'websocket'},
        homeserver_url: config.matrix.homeserver,
        homeserver_domain: config.matrix.domain,
        your_user_id: config.owner,
    };
    for (const url of ['websocket', '', null, registration.url]) {
        const parsed = parseRegistration(
            JSON.stringify({...envelope, registration: {...registration, url}}),
            config,
        );
        assert.equal(parsed.registration.getOutput().url, 'http://127.0.0.1:29339');
        assert.equal(parsed.registration.getAppServiceToken(), registration.as_token);
        assert.equal(parsed.registration.getHomeserverToken(), registration.hs_token);
        assert.deepEqual(parsed.registration.getOutput().namespaces, registration.namespaces);
    }
    for (const invalid of [
        {...envelope, your_user_id: '@other:example.invalid'},
        {...envelope, homeserver_domain: 'other.invalid'},
        {...envelope, homeserver_url: 'https://other.invalid'},
        {...envelope, homeserver_url: config.matrix.homeserver + '/path'},
        {...envelope, homeserver_url: config.matrix.homeserver + '?secret=fixture'},
        {...envelope, registration: null},
        {...envelope, registration: []},
        {...envelope, registration: {...registration, url: 'https://external.invalid'}},
        {...envelope, registration: {...registration, url: undefined}},
    ])
        assert.throws(() => parseRegistration(JSON.stringify(invalid), config), {
            message: 'Invalid appservice registration',
        });
    assert.throws(
        () => parseRegistration(JSON.stringify({...registration, url: 'websocket'}), config),
        {message: 'Invalid appservice registration'},
    );
    const json = JSON.stringify(envelope);
    assert.throws(
        () =>
            parseRegistration(
                json.replace(
                    '"your_user_id":',
                    '"your_user_id":"@other:example.invalid","your_user_id":',
                ),
                config,
            ),
        {message: 'Invalid appservice registration'},
    );
});

await test('bbctl per-user API URL survives configuration and registration validation', () => {
    const routed = {
        ...config,
        matrix: {
            ...config.matrix,
            homeserver: 'https://matrix.beeper.com/_hungryserv/owner',
            domain: 'beeper.local',
        },
    };
    const registration = parseRegistration(source, config).registration.getOutput();
    const envelope = {
        registration: {...registration, url: 'websocket'},
        your_user_id: config.owner,
        homeserver_domain: 'beeper.local',
        homeserver_url: routed.matrix.homeserver + '/',
    };
    assert.equal(parseRegistration(JSON.stringify(envelope), routed).domain, 'beeper.local');
    for (const homeserver_url of [
        'https://matrix.beeper.com',
        'https://matrix.beeper.com/_hungryserv/other',
    ])
        assert.throws(() =>
            parseRegistration(JSON.stringify({...envelope, homeserver_url}), routed),
        );
});
