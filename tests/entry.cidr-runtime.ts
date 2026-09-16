import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {patchCidrSource} from '../scripts/runtime-dependency-overrides.ts';

const packaged = existsSync(new URL('../context-integrity.json', import.meta.url));
const require = createRequire(packaged
    ? new URL('../.local/sources/matrix-appservice-bridge/package.json', import.meta.url)
    : import.meta.url);
const cidrPath = require.resolve(packaged ? 'ip-cidr' : '../native/runtime-dependencies/node_modules/ip-cidr');
const cidrRequire = createRequire(cidrPath);
const original = readFileSync(cidrPath, 'utf8');
const patched = patchCidrSource(original);
// Preserve the installed dependency resolution when loading this isolated patched fixture.
const source = patched.replace("from 'ip-address'",
    'from ' + JSON.stringify(pathToFileURL(cidrRequire.resolve('ip-address')).href));
const {default: Cidr} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

await test('CIDR compatibility preserves IPv4 and IPv6 ranges, boundaries and bigint conversion', async () => {
    for (const [range, first, last, outside] of [
        ['192.0.2.0/30', '192.0.2.0', '192.0.2.3', '192.0.2.4'],
        ['2001:db8::/126', '2001:db8::', '2001:db8::3', '2001:db8::4'],
    ]) {
        const cidr = new Cidr(range);
        assert.equal(cidr.size, 4n);
        assert(cidr.contains(first)); assert(cidr.contains(last)); assert(!cidr.contains(outside));
        assert(cidr.contains(cidr.start({type: 'bigInteger'})));
        assert.equal(cidr.toArray({limit: 2}).length, 2);
        assert.equal((await cidr.loop((value: string) => value, {limit: 2})).length, 2);
        for (const value of cidr.toRange()) assert(cidr.contains(value));
    }
    assert(new Cidr('192.0.2.1/32').contains('192.0.2.1'));
    assert(!new Cidr('192.0.2.1/32').contains('192.0.2.2'));
    assert(new Cidr('2001:db8::1/128').contains('2001:db8::1'));
    assert(!new Cidr('2001:db8::1/128').contains('2001:db8::2'));
    assert(new Cidr('192.0.2.0/24').contains('::ffff:192.0.2.1'));
    assert(!new Cidr('192.0.2.0/24').contains('::ffff:198.51.100.1'));
});

await test('fixed IP parser rejects ambiguous IPv4 notation and CIDR adaptation rejects changed sources', () => {
    const {Address4} = cidrRequire('ip-address');
    assert(Address4.isValid('192.0.2.1'));
    assert(!Address4.isValid('192.000.2.1'));
    assert.throws(() => new Address4('192.000.2.1'));
    assert.throws(() => new Cidr('192.000.2.0/24'));
    assert(!new Cidr('192.0.2.0/24').contains('not-an-address'));
    assert.throws(() => patchCidrSource(original + '\n'), /changed ip-cidr source/u);
    assert.equal(patchCidrSource(patched), patched);
});
