import {
    Bridge,
    AppServiceRegistration,
} from '../../.local/sources/matrix-appservice-bridge/lib/index.js';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
    MatrixClient,
    LogLevel,
    LogService,
} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {ProtectedAppserviceStorage} from '../../src/matrix/appservice-storage.ts';

LogService.setLevel(LogLevel.ERROR);
assert.equal(process.versions.node.split('.')[0], '24');
await test('appservice login saves the user token and reuses device keys across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-as-login-'));
    const master = randomBytes(32);
    const user = '@bridge_alice:example.invalid';
    const asToken = 'synthetic-appservice-token';
    const userToken = 'synthetic-user-access-token';
    let deviceId: string | undefined;
    let logins = 0;
    let offline = false;
    let storage: ProtectedAppserviceStorage | undefined;
    let appservice: Bridge | undefined;
    const originalRequest = MatrixClient.prototype.doRequest;
    // Intercept new SDK clients as well as the initial intent. No real network is used.
    MatrixClient.prototype.doRequest = async function (
        _method: string,
        path: string,
        _query?: any,
        body?: any,
    ): Promise<any> {
        if (path.endsWith('/register')) return {user_id: user};
        if (path.endsWith('/devices')) return {devices: []};
        if (path.includes('/devices/'))
            throw new Error('synthetic legacy homeserver: device masquerading unavailable');
        if (path.endsWith('/keys/query')) return {device_keys: {}, failures: {}};
        if (path.endsWith('/login') && _method === 'GET')
            return {flows: [{type: 'm.login.application_service'}]};
        if (path.endsWith('/login')) {
            assert.equal(this.accessToken, asToken);
            assert.equal(body.identifier.user, user);
            assert.equal(typeof body.device_id, 'string');
            logins++;
            deviceId = body.device_id;
            return {user_id: user, device_id: deviceId, access_token: userToken};
        }
        if (path.endsWith('/account/whoami')) {
            if (offline) throw new Error('synthetic network timeout');
            assert.equal(this.accessToken, userToken);
            return {user_id: user, device_id: deviceId};
        }
        if (path.endsWith('/keys/upload')) {
            assert.equal(this.accessToken, userToken);
            return {one_time_key_counts: {signed_curve25519: 50}};
        }
        throw new Error(`Unexpected mock endpoint: ${path}`);
    };
    async function open(): Promise<Bridge> {
        storage = new ProtectedAppserviceStorage(directory, master);
        const registration = AppServiceRegistration.fromObject({
            id: 'synthetic',
            url: 'http://127.0.0.1:29339',
            as_token: asToken,
            hs_token: 'synthetic-homeserver-token',
            sender_localpart: 'bridge_bot',
            namespaces: {
                users: [{regex: '@bridge_.*:example.invalid', exclusive: true}],
                rooms: [],
                aliases: [],
            },
        });
        assert.ok(registration);
        const bridge = new Bridge({
            domain: 'example.invalid',
            homeserverUrl: 'https://example.invalid',
            registration,
            disableStores: true,
            logRequestOutcome: false,
            controller: {onEvent: () => undefined},
            nativeEncryption: {
                storage,
                cryptoStorage: {storageForUser: (id) => storage!.cryptoForUser(id)},
            },
        });
        await bridge.initialise();
        await assert.rejects(bridge.listen(0, '127.0.0.1'), /durable transaction ingress/);
        return bridge;
    }

    try {
        appservice = await open();
        const first = appservice.getIntent(user).botSdkIntent;
        await first.enableEncryption();
        assert.equal(logins, 1);
        assert.equal(await storage!.storageForUser(user).readValue('accessToken'), userToken);
        const identity = first.underlyingClient.crypto.clientDeviceEd25519;
        first.underlyingClient.crypto.close();
        await appservice.close();
        storage!.close();
        appservice = await open();
        const second = appservice.getIntent(user).botSdkIntent;
        await second.enableEncryption();
        assert.equal(logins, 1, 'Restart must use the encrypted saved user token');
        assert.equal(second.underlyingClient.crypto.clientDeviceEd25519, identity);
        second.underlyingClient.crypto.close();
        await appservice.close();
        storage!.close();
        appservice = await open();
        offline = true;
        await assert.rejects(
            appservice.getIntent(user).botSdkIntent.enableEncryption(),
            /could not be verified/,
        );
        assert.equal(logins, 1, 'A network failure must not trigger a replacement login');
        offline = false;
        const recovered = appservice.getIntent(user).botSdkIntent;
        await recovered.enableEncryption();
        assert.equal(recovered.underlyingClient.crypto.clientDeviceEd25519, identity);
        assert.equal(logins, 1);
    } finally {
        appservice?.getIntent(user).botSdkIntent.underlyingClient.crypto?.close();
        await appservice?.close();
        storage?.close();
        MatrixClient.prototype.doRequest = originalRequest;
        master.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
