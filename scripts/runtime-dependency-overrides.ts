import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** ip-cidr 4 already uses native bigint; ip-address 10 renamed these methods. */
export function patchCidrSource(source: string): string {
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    if (hash(source) === '97ca2aa24e808b829220b5e21aa1fda4a1f74c1dab5e4b630250c597486327a2') return source;
    assert.equal(hash(source), 'b2aa84deae7e08567289aa91a80d2f2e66ea16b6294fa8d63f4fe8af51801371',
        'Review a changed ip-cidr source before applying the compatibility patch');
    const patched = source.replaceAll('.bigInteger(', '.bigInt(')
        .replaceAll('.fromBigInteger(', '.fromBigInt(');
    assert.equal(hash(patched), '97ca2aa24e808b829220b5e21aa1fda4a1f74c1dab5e4b630250c597486327a2');
    return patched;
}
