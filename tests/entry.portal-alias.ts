import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AppServiceRegistration} from '../.local/sources/matrix-appservice-bridge/lib/index.js';
import {assertPortalAlias} from '../src/service/portal-alias.ts';
await test('user-only Beeper registration permits only canonical local aliases', () => {
    const reg = new AppServiceRegistration('http://127.0.0.1:29339');
    reg.setId('test');
    reg.setHomeserverToken('synthetic-hs');
    reg.setAppServiceToken('synthetic-as');
    reg.setSenderLocalpart('bot');
    const check = (alias: string) => assertPortalAlias(reg, 'sh-threema', 'beeper.local', alias);
    check('#sh-threema_' + 'a'.repeat(40) + ':beeper.local');
    check('#sh-threema_management_' + 'b'.repeat(40) + ':beeper.local');
    for (const alias of [
        '#other_' + 'a'.repeat(40) + ':beeper.local',
        '#sh-threema_x:beeper.local',
        '#sh-threema_' + 'a'.repeat(40) + ':foreign',
    ])
        assert.throws(() => check(alias));
    reg.addRegexPattern('aliases', '^#reserved_.+:beeper\\.local$', true);
    assert.throws(() => check('#sh-threema_' + 'a'.repeat(40) + ':beeper.local'));
});
