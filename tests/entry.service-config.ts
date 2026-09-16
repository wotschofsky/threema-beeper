import {serializeServiceConfig} from '../src/service/config-output.ts';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, symlink, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {parseServiceConfig, readServiceConfig} from '../src/service/config.ts';
const example = await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8');
await test('example service YAML preserves nonsecret paths and converts bounded operational settings', async () => {
    const config = await readServiceConfig(resolve('config.example.yaml'));
    assert.equal(config.profileDirectory, '/data/profiles/primary');
    assert.equal(config.identity, 'ABCD1234');
    assert.equal(config.matrix.domain, 'example.invalid');
    assert.equal(config.matrix.homeserver, 'https://matrix.example.invalid');
    assert.equal(config.startupTimeoutMs, 90000);
    assert.equal(config.sync.periodicMs, 86400000);
    assert.equal(config.sync.pageSize, 500);
    assert.equal(config.media.maximumBytes, 100 * 1024 ** 2);
});
await test('configuration rejects unsafe, ambiguous and unsupported settings without returning source values', () => {
    const invalid = [
        example.replace('    domain: example.invalid\n', ''),
        ...[
            'https://example.invalid',
            'example.invalid/path',
            'example.invalid:65536',
            '.invalid',
            'example..invalid',
            '-example.invalid',
            'example.invalid:0',
        ].map((domain) => example.replace('domain: example.invalid', `domain: ${domain}`)),
        example.replace('  profile_id: primary', '  profile_id: ../../other'),
        example.replace('  data_dir: /data', '  data_dir: /data/../other'),
        example.replace('    port: 29339', '    port: 65536'),
        example.replace('    page_size: 500', '    page_size: 501'),
        example.replace('    require_encryption: true', '    require_encryption: false'),
        example.replace('    polls: false', '    polls: true'),
        example.replace('    auto_download: true', '    auto_download: false'),
        example.replace('    listen: 127.0.0.1', '    listen: 0.0.0.0'),
        example.replace('    max_inbound_bytes: 100MiB', '    max_inbound_bytes: 1025MiB'),
        example.replace(
            'https://matrix.example.invalid',
            'https://user:secret@matrix.example.invalid',
        ),
        example.replace('https://matrix.example.invalid', 'http://matrix.example.invalid'),
        example.replace(
            '  displayname: Threema',
            '  displayname: Threema\n  displayname: Duplicate',
        ),
        example.replace('  displayname: Threema', '  password: synthetic-private-credential'),
        example.replace('  displayname: Threema', '  displayname: &value Threema\n  owner: *value'),
        'x'.repeat(65537),
    ];
    for (const value of invalid)
        assert.throws(
            () => parseServiceConfig(value),
            (error: Error) => {
                assert.ok(!error.message.includes('synthetic-private-credential'));
                assert.ok(!error.message.includes('user:secret'));
                return true;
            },
        );
});
await test('configuration file reads reject symlinks and oversized inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threema-config-'));
    try {
        await writeFile(join(directory, 'large'), 'x'.repeat(65537));
        await symlink(resolve('config.example.yaml'), join(directory, 'link'));
        await assert.rejects(
            readServiceConfig(join(directory, 'large')),
            /Invalid configuration file/,
        );
        await assert.rejects(readServiceConfig(join(directory, 'link')));
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});

await test('configuration retains the owner-specific bbctl API prefix', () => {
    for (const suffix of ['', '/']) {
        const parsed = parseServiceConfig(
            example.replace(
                'https://matrix.example.invalid',
                'https://matrix.beeper.com/_hungryserv/owner' + suffix,
            ),
        );
        assert.equal(parsed.matrix.homeserver, 'https://matrix.beeper.com/_hungryserv/owner');
    }
    for (const path of [
        '/other',
        '/_hungryserv/other',
        '/_hungryserv/owner/extra',
        '/_hungryserv/owner?token=x',
    ])
        assert.throws(() =>
            parseServiceConfig(
                example.replace(
                    'https://matrix.example.invalid',
                    'https://matrix.beeper.com' + path,
                ),
            ),
        );
});

await test('Matrix namespace defaults remain stable and explicit bridge names are bounded', () => {
    assert.equal(parseServiceConfig(example).matrix.namespace, 'threema');
    assert.equal(
        parseServiceConfig(example.replace('    domain:', '    namespace: sh-threema\n    domain:'))
            .matrix.namespace,
        'sh-threema',
    );
    for (const namespace of ['bad_name', 'UPPER', 'x'.repeat(33), '@other:invalid'])
        assert.throws(() =>
            parseServiceConfig(
                example.replace('    domain:', `    namespace: "${namespace}"\n    domain:`),
            ),
        );
});

await test('groups and media opt in independently and reject ambiguous flags or relative codec paths', () => {
    assert.deepEqual(parseServiceConfig(example).features, {
        groups: false,
        media: false,
        reactions: false,
        mutations: false,
        receipts: false,
    });
    assert.deepEqual(
        parseServiceConfig(example.replace('groups: false', 'groups: true')).features,
        {groups: true, media: false, reactions: false, mutations: false, receipts: false},
    );
    const enabled = parseServiceConfig(example.replace('media: false', 'media: true'));
    assert.deepEqual(enabled.features, {
        groups: false,
        media: true,
        reactions: false,
        mutations: false,
        receipts: false,
    });
    assert.equal(enabled.media.tools?.limiter, '/usr/local/bin/media-limits');
    assert.throws(() => parseServiceConfig(example.replace('groups: false', 'groups: yes')));
    assert.throws(() => parseServiceConfig(example.replace('media: false', 'media: 1')));
    assert.throws(() =>
        parseServiceConfig(example.replace('ffmpeg: /usr/local/bin/ffmpeg', 'ffmpeg: ./ffmpeg')),
    );
});

await test('daily feature settings and codec configuration survive backup configuration serialization', () => {
    const config = parseServiceConfig(
        example
            .replace('reactions: false', 'reactions: true')
            .replace('mutations: false', 'mutations: true')
            .replace('receipts: false', 'receipts: true')
            .replace('media: false', 'media: true'),
    );
    assert.deepEqual(parseServiceConfig(serializeServiceConfig(config)), config);
    for (const flag of ['reactions', 'mutations', 'receipts'])
        assert.throws(() => parseServiceConfig(example.replace(flag + ': false', flag + ': yes')));
});
