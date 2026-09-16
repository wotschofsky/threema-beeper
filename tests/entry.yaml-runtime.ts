import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';

const packaged = existsSync(new URL('../context-integrity.json', import.meta.url));
const require = createRequire(packaged
    ? new URL('../.local/sources/matrix-appservice-bridge/package.json', import.meta.url)
    : import.meta.url);
const yaml = require(packaged ? 'js-yaml' : '../native/runtime-dependencies/node_modules/js-yaml') as {
    load: (text: string, options?: Record<string, unknown>) => unknown;
    dump: (value: unknown) => string;
};

await test('pinned YAML parser preserves bridge configuration and registration values', () => {
    const example = yaml.load(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'));
    assert.deepEqual(yaml.load(yaml.dump(example)), example);
    const registration = {id: 'synthetic', as_token: 'test-only', hs_token: 'test-only',
        sender_localpart: 'threema', namespaces: {users: [{exclusive: true, regex: '@threema_.*'}]}};
    assert.deepEqual(yaml.load(yaml.dump(registration)), registration);
    assert.deepEqual(yaml.load('defaults: &defaults {enabled: true}\nsettings: {<<: *defaults, limit: 2}\n'),
        {defaults: {enabled: true}, settings: {enabled: true, limit: 2}});
});

await test('empty YAML merge sources consume the configured parser budget', () => {
    const document = 'first: &first {}\nsecond: &second {}\nsettings: {<<: [*first, *second]}\n';
    assert.throws(() => yaml.load(document, {maxTotalMergeKeys: 1}), /merge/i);
    assert.deepEqual(yaml.load(document, {maxTotalMergeKeys: 2}), {first: {}, second: {}, settings: {}});
});
