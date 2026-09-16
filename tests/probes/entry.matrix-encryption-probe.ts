import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';

import {
    AppServiceRegistration,
    Bridge,
    EncryptedIntent,
} from '../../.local/sources/matrix-appservice-bridge/lib/index.js';

// Only synthetic data and a loopback mock homeserver are used. This probes the
// actual pinned framework; it is not a Beeper interoperability acceptance test.
const userId = '@spike_alice:example.test';
const roomId = '!spike:example.test';
const payload = {msgtype: 'm.text', body: 'synthetic gate zero probe'};
let observedSend: {path: string; body: unknown} | undefined;
const unexpectedRequests: string[] = [];
const server = createServer((request, response) => {
    void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }
        const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        response.setHeader('Content-Type', 'application/json');
        if (requestPath.endsWith('/login') && request.method === 'GET') {
            response.end(JSON.stringify({flows: [{type: 'm.login.application_service'}]}));
        } else if (requestPath.endsWith('/account/whoami')) {
            response.end(JSON.stringify({user_id: userId, device_id: 'SPIKE'}));
        } else if (requestPath.includes('/state/m.room.encryption')) {
            response.end(JSON.stringify({algorithm: 'm.megolm.v1.aes-sha2'}));
        } else if (requestPath.includes('/send/')) {
            observedSend = {
                path: decodeURIComponent(requestPath),
                body: JSON.parse(Buffer.concat(chunks).toString()),
            };
            response.end(JSON.stringify({event_id: '$synthetic'}));
        } else {
            unexpectedRequests.push(requestPath);
            response.writeHead(404);
            response.end(JSON.stringify({errcode: 'M_NOT_FOUND'}));
        }
    })().catch(() => {
        response.writeHead(500);
        response.end('{}');
    });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address !== null && typeof address !== 'string');
const homeserverUrl = `http://127.0.0.1:${address.port}`;
const registration = AppServiceRegistration.fromObject({
    id: 'spike',
    url: 'http://127.0.0.1:29339',
    as_token: 'synthetic-as-token',
    hs_token: 'synthetic-hs-token',
    sender_localpart: 'spike_bot',
    namespaces: {
        users: [{regex: '@spike_.*:example.test', exclusive: true}],
        aliases: [],
        rooms: [],
    },
});
assert(registration !== null);
const session = {userId, accessToken: 'synthetic-session', deviceId: 'SPIKE', syncToken: null};
const bridge = new Bridge({
    homeserverUrl,
    domain: 'example.test',
    registration,
    disableStores: true,
    logRequestOutcome: false,
    controller: {onEvent: () => undefined},
    bridgeEncryption: {
        homeserverUrl,
        store: {
            getStoredSession: async () => session,
            setStoredSession: async () => undefined,
            updateSyncToken: async () => undefined,
        },
    },
});

try {
    await bridge.initialise();
    const ghost = bridge.getIntent(userId);
    assert(ghost instanceof EncryptedIntent);
    assert.equal(ghost.matrixClient.crypto, undefined);
    assert.equal(bridge.getIntent().matrixClient.crypto, undefined);
    assert.equal(bridge.getIntent() instanceof EncryptedIntent, false);

    // Isolate the send path from the long-running Pantalaimon sync scheduler.
    // The actual SDK client, encrypted intent, and HTTP send remain unmodified.
    let syncRequested = false;
    const intent = new EncryptedIntent(
        ghost.botSdkIntent,
        bridge.getIntent().matrixClient,
        {registered: true, dontJoin: true, dontCheckPowerLevel: true, enablePresence: false},
        {
            originalHomeserverUrl: homeserverUrl,
            sessionPromise: Promise.resolve(session),
            sessionCreatedCallback: async () => undefined,
            ensureClientSyncingCallback: async () => {
                syncRequested = true;
            },
        },
    );
    await intent.sendEvent(roomId, 'm.room.message', payload);
    assert.equal(syncRequested, true);
    assert(observedSend !== undefined);
    assert(observedSend.path.includes('/send/m.room.message/'));
    assert.deepEqual(observedSend.body, payload);
    assert.deepEqual(unexpectedRequests, []);
    console.log(
        JSON.stringify({
            node: process.version,
            framework: '12.0.0',
            result: 'confirmed-proxy-dependency',
            builtInNativeCrypto: false,
            encryptedRoomSendRequiresProxyEncryption: true,
            beeperGatePassed: false,
        }),
    );
} finally {
    await bridge.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}
