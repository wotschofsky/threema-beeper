import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {connectionIssues, connectionDialogIssue, dismissConnectionDialog} from '../integrations/threema/overlay/src/headless/node-connection-issue.ts';
import {BackendController} from '../src/threema/backend-controller.ts';
await test('known upstream dialogs report only categories and never confirm an action', async () => {
    const reports: string[] = [];
    for (const issue of connectionIssues) {
        const dialog = issue === 'device-protocols-incompatible' ? {type: issue}
            : {type: 'connection-error', context: {error: issue, secret: 'never-forward'}};
        const handle = dismissConnectionDialog(dialog, value => reports.push(value));
        assert(handle); assert.deepEqual(await handle.closed, {type: 'dismissed'});
        handle.setProgress(0.5);
    }
    assert.deepEqual(reports, [...connectionIssues]);
    assert.deepEqual(await dismissConnectionDialog({type: 'connection-error', context: {error: 'client-update-required'}}, () => {throw new Error('Failed reporter');})?.closed, {type: 'dismissed'});
});
await test('arbitrary alerts, unknown errors and security/destructive dialogs are not handled', () => {
    for (const value of [null, {}, {type: 'server-alert', context: {text: 'secret'}},
        {type: 'connection-error', context: {error: 'unknown'}}, {type: 'connection-error', context: {error: 'device-protocols-incompatible'}},
        {type: 'change-password-confirm-dialog'}, {type: 'remote-secrets-activation'}]) {
        assert.equal(connectionDialogIssue(value), undefined);
        assert.equal(dismissConnectionDialog(value, () => {throw new Error('Unexpected callback');}), undefined);
    }
});
await test('worker boundary filters unknown issue codes and keeps requests working after a throwing observer', async () => {
    const observed: string[] = [];
    const code = `import {parentPort} from 'node:worker_threads';
        parentPort.postMessage({type:'initialized'});
        parentPort.on('message', message => {
            parentPort.postMessage({type:'connection-issue',code:'client-update-required',detail:'secret'});
            parentPort.postMessage({type:'connection-issue',code:'unknown secret'});
            parentPort.postMessage({type:'result',id:message.id,value:'SELF1234'});
        });`;
    const controller = new BackendController({profileDirectory: '/unused', wasmFile: '/unused',
        onConnectionIssue: issue => {observed.push(issue); throw new Error('Observer failed');}},
        (_entry, options) => new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)), options));
    try {
        await controller.ready;
        assert.equal(await controller.identity(), 'SELF1234');
        assert.deepEqual(observed, ['client-update-required']);
    } finally { await controller.stop(); }
});
