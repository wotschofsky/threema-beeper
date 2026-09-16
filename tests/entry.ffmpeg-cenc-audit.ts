import assert from 'node:assert/strict';
import {test} from 'node:test';
import {auditCencGuards} from '../scripts/ffmpeg-cenc-audit.ts';

await test('CENC source audit rejects each missing 64-bit guard independently', () => {
    const names = ['cenc_scheme_decrypt', 'cbc1_scheme_decrypt', 'cens_scheme_decrypt', 'cbcs_scheme_decrypt'];
    const body = (fixed: boolean) => `if (sample->subsamples[i].bytes_of_clear_data + ${fixed ? '(int64_t)' : ''}sample->subsamples[i].bytes_of_protected_data > size) return -1;`;
    const fixture = (bad = -1) => names.map((name, i) => `static int ${name}(void) { ${body(i !== bad)} }`).join('\n');
    assert.deepEqual(auditCencGuards(fixture()), names);
    for (let i = 0; i < 4; i++) assert.throws(() => auditCencGuards(fixture(i)));
    assert.throws(() => auditCencGuards(''));
});
