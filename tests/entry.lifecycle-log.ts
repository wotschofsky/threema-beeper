import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {lifecycleLog, type LifecycleEvent} from '../src/service/lifecycle-log.ts';

await test('lifecycle records accept only a fixed vocabulary and bounded numeric durations', () => {
    const record = JSON.parse(lifecycleLog('configuration-rejected', 10.3));
    assert.equal(record.audit, true);
    assert.equal(record.error, 'invalid-configuration');
    assert.equal(record.durationMs, 10);
    assert.equal(record.profile, 'primary');
    for (const event of ['SECRET-TOKEN', '__proto__', 'constructor'])
        assert.throws(() => lifecycleLog(event as LifecycleEvent, 0));
    for (const time of [NaN, Infinity, -1])
        assert.throws(() => lifecycleLog('service-started', time));
    assert.equal(lifecycleLog('service-started', 0).split('\n').length, 2);
});
await test('service configuration rejection emits a structured audit without the input filename', () => {
    const filename = '/nonexistent/SECRET-PROFILE-NAME.yaml';
    const result = spawnSync(process.execPath, ['src/service/entry.service.ts', filename], {
        encoding: 'utf8',
        timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert(!result.stderr.includes('SECRET'));
    const record = JSON.parse(result.stderr);
    assert.equal(record.event, 'configuration-rejected');
    assert.equal(record.audit, true);
});
