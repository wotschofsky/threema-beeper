import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {parseServiceConfig} from '../src/service/config.ts';
import {serializeServiceConfig} from '../src/service/config-output.ts';
import {linuxServiceConfig} from '../src/service/linux-config.ts';
await test('Linux configuration keeps identity, flags and encryption while selecting the verified proxy and Linux codecs', () => {
    const source = parseServiceConfig(readFileSync('config.example.yaml', 'utf8'));
    source.features!.groups = true;
    source.features!.media = true;
    source.features!.receipts = true;
    source.matrix.protocolAvatar = 'mxc://example.invalid/icon';
    const result = parseServiceConfig(
        serializeServiceConfig(linuxServiceConfig(source, 'a'.repeat(64))),
    );
    assert.equal(result.identity, source.identity);
    assert.equal(result.owner, source.owner);
    assert.deepEqual(result.features, source.features);
    assert.equal(result.matrix.protocolAvatar, source.matrix.protocolAvatar);
    assert.equal(result.proxy?.statusReporting, true);
    assert.equal(result.proxy?.sha256, 'a'.repeat(64));
    assert.equal(result.media.tools?.ffmpeg, '/usr/bin/ffmpeg');
    assert.match(serializeServiceConfig(result), /"require_encryption": true/);
    assert.equal(result.profileDirectory, '/installation/data/profiles/primary');
    assert.throws(() => linuxServiceConfig(source, 'bad'));
});
