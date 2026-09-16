import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertFreshSecurityDatabase} from '../src/operations/security-database.ts';
await test('database acceptance requires validity, supported schema and a bounded age', () => {
    const now = Date.parse('2026-09-16T12:00:00Z');
    const db = {valid: true, schemaVersion: 'v6.1.9', built: '2026-09-15T06:31:36Z'};
    assertFreshSecurityDatabase(db, now);
    for (const changes of [{valid: false}, {schemaVersion: 'v5.0.0'}, {built: 'invalid'},
        {built: '2026-09-01T00:00:00Z'}, {built: '2026-09-17T00:00:00Z'}])
        assert.throws(() => assertFreshSecurityDatabase({...db, ...changes}, now));
    assert.throws(() => assertFreshSecurityDatabase(null, now));
    assert.throws(() => assertFreshSecurityDatabase(db, NaN));
});
