import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MatrixClient} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/index.js';
import {GhostManager, ghostUserId, type GhostIntent} from '../src/matrix/ghosts.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';

for (const namespace of ['threema', 'sh-threema'])
    await test(
        namespace +
            ': ghost mappings, names and membership converge after lost join reply and restart',
        async () => {
            const directory = mkdtempSync(join(tmpdir(), 'threema-ghosts-'));
            const filename = join(directory, 'portals.sqlite');
            const key = randomBytes(32);
            let store = new PortalStore(filename, key);
            const profile = 'SELF1234',
                domain = 'matrix.invalid',
                room = '!portal:matrix.invalid',
                chat = 'c:TEST1234';
            const botId = '@bot:matrix.invalid';
            const owner = '@owner:matrix.invalid';
            const desired = ghostUserId(profile, 'TEST1234', domain, namespace);
            const stale = ghostUserId(profile, '*OLD1234', domain, namespace);
            const foreign = ghostUserId('OTHR1234', 'TEST1234', domain, namespace);
            const unbound = ghostUserId(profile, 'NONE1234', domain, namespace);
            const members = new Map([
                [owner, 'join'],
                [foreign, 'join'],
                [unbound, 'join'],
                [stale, 'join'],
            ]);
            const names = new Map<string, string>();
            const enabled = new Set<string>();
            let lostReply = true;
            let joins = 0,
                invites = 0,
                namesSet = 0;
            let validMarker = true;
            const botClient = new MatrixClient('https://matrix.invalid', 'synthetic');
            botClient.doRequest = async (_method, path, _query, body): Promise<any> => {
                if (path.endsWith('/state'))
                    return [
                        {
                            type: 'm.room.encryption',
                            state_key: '',
                            content: {algorithm: 'm.megolm.v1.aes-sha2'},
                        },
                        {
                            type: 'm.bridge',
                            state_key: 'threema://bridge',
                            sender: validMarker ? botId : owner,
                            content: {network: {id: profile}, channel: {id: chat}},
                        },
                        ...[...members].map(([state_key, membership]) => ({
                            type: 'm.room.member',
                            state_key,
                            content: {membership},
                        })),
                    ];
                assert.ok(path.endsWith('/invite'));
                assert.ok(enabled.has(body.user_id));
                invites++;
                members.set(body.user_id, 'invite');
                return {};
            };
            const intents = new Map<string, GhostIntent>();
            function getIntent(mxid: string): GhostIntent {
                let intent = intents.get(mxid);
                if (intent) return intent;
                const client = new MatrixClient('https://matrix.invalid', 'synthetic');
                client.doRequest = async (method, path, _query, body): Promise<any> => {
                    if (path.endsWith('/account/whoami'))
                        return {user_id: mxid, device_id: 'SYNTHETIC'};
                    assert.ok(path.includes('/profile/'));
                    if (method === 'GET') return {displayname: names.get(mxid)};
                    assert.equal(method, 'PUT');
                    namesSet++;
                    names.set(mxid, body.displayname);
                    return {};
                };
                intent = {
                    userId: mxid,
                    underlyingClient: client,
                    ensureRegistered: async () => {},
                    enableEncryption: async () => {
                        enabled.add(mxid);
                    },
                    joinRoom: async () => {
                        joins++;
                        assert.equal(members.get(mxid), 'invite');
                        members.set(mxid, 'join');
                        if (lostReply) {
                            lostReply = false;
                            throw new Error('synthetic lost join reply');
                        }
                        return room;
                    },
                    leaveRoom: async () => {
                        members.set(mxid, 'leave');
                    },
                };
                intents.set(mxid, intent);
                return intent;
            }
            const make = () =>
                new GhostManager(
                    store,
                    profile,
                    domain,
                    {userId: botId, underlyingClient: botClient},
                    getIntent,
                    namespace,
                );
            let manager = make();
            try {
                assert.equal(
                    ghostUserId('SELF1234', '*OLD1234', domain, namespace),
                    `@${namespace}_53454c4631323334_2a4f4c4431323334:matrix.invalid`,
                );
                assert.throws(() => ghostUserId(profile, 'bad', domain, namespace), /identity/);
                store.bind(profile, chat, room);
                await manager.ensure('*OLD1234', 'Old');
                await Promise.all([
                    manager.ensure('TEST1234', 'First'),
                    manager.ensure('TEST1234', 'Updated'),
                ]);
                assert.equal(names.get(desired), 'Updated');
                const count = namesSet;
                await manager.ensure('TEST1234', 'Updated');
                assert.equal(namesSet, count);
                await assert.rejects(manager.reconcile(room, chat, ['TEST1234']), /lost join/);
                assert.equal(members.get(stale), 'leave');
                store.close();
                store = new PortalStore(filename, key);
                manager = make();
                await manager.reconcile(room, chat, ['TEST1234']);
                assert.equal(store.ghost(profile, 'TEST1234'), desired);
                assert.equal(joins, 1);
                assert.equal(invites, 1);
                for (const mxid of [owner, foreign, unbound, desired])
                    assert.equal(members.get(mxid), 'join');
                validMarker = false;
                await assert.rejects(manager.reconcile(room, chat, []), /verification/);
                assert.equal(members.get(desired), 'join');
                validMarker = true;
                await manager.reconcile(room, chat, []);
                assert.equal(members.get(desired), 'leave');
                members.set(desired, 'ban');
                await assert.rejects(manager.reconcile(room, chat, ['TEST1234']), /banned/);
                assert.equal(invites, 1);
            } finally {
                store.close();
                key.fill(0);
                rmSync(directory, {recursive: true, force: true});
            }
        },
    );
