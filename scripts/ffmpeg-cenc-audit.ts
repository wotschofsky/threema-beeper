import assert from 'node:assert/strict';

/** Check every guard changed by upstream backport 2b14ba12669d75f5f73d8634c6db36e704144532. */
export function auditCencGuards(source: string): string[] {
    const functions = ['cenc_scheme_decrypt', 'cbc1_scheme_decrypt', 'cens_scheme_decrypt', 'cbcs_scheme_decrypt'];
    const fixed = 'sample->subsamples[i].bytes_of_clear_data + (int64_t)sample->subsamples[i].bytes_of_protected_data > size';
    const vulnerable = 'sample->subsamples[i].bytes_of_clear_data + sample->subsamples[i].bytes_of_protected_data > size';
    for (const name of functions) {
        const match = new RegExp(`static int ${name}\\([\\s\\S]*?(?=\\nstatic |$)`).exec(source);
        assert(match, 'Missing CENC function: ' + name);
        assert.equal(match[0].split(fixed).length - 1, 1, 'Missing or ambiguous fixed guard: ' + name);
        assert(!match[0].includes(vulnerable), 'Vulnerable guard remains: ' + name);
    }
    return functions;
}
