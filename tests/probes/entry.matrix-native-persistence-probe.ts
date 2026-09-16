import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
    DeviceId,
    EncryptionSettings,
    OlmMachine,
    RoomId,
    UserId,
} from '../../.local/sources/matrix-appservice-bridge/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/index.js';

assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24');

await test('native Matrix crypto preserves identity and Megolm keys in a passphrase-protected store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'threema-matrix-crypto-'));
    const secret = randomBytes(32).toString('base64');
    const user = new UserId('@synthetic:example.invalid');
    const device = new DeviceId('SYNTHETIC');
    const room = new RoomId('!synthetic:example.invalid');
    let machine: OlmMachine | undefined;
    try {
        machine = await OlmMachine.initialize(user, device, directory, secret);
        const identity = machine.identityKeys.ed25519.toBase64();
        await machine.shareRoomKey(room, [], new EncryptionSettings());
        const body = `synthetic-${randomBytes(16).toString('hex')}`;
        const content = JSON.parse(
            await machine.encryptRoomEvent(
                room,
                'm.room.message',
                JSON.stringify({msgtype: 'm.text', body}),
            ),
        ) as Record<string, unknown>;
        assert.equal(content.algorithm, 'm.megolm.v1.aes-sha2');
        assert.equal(typeof content.ciphertext, 'string');
        assert.ok(!JSON.stringify(content).includes(body));
        const event = JSON.stringify({
            type: 'm.room.encrypted',
            event_id: '$synthetic',
            sender: user.toString(),
            origin_server_ts: 1,
            content,
        });
        machine.close();
        machine = undefined;
        await assert.rejects(async () => {
            const wrong = await OlmMachine.initialize(user, device, directory, 'wrong-passphrase');
            wrong.close();
        });
        machine = await OlmMachine.initialize(user, device, directory, secret);
        assert.equal(machine.identityKeys.ed25519.toBase64(), identity);
        const decrypted = JSON.parse((await machine.decryptRoomEvent(event, room)).event) as {
            type: string;
            content: {body: string};
        };
        assert.equal(decrypted.type, 'm.room.message');
        assert.equal(decrypted.content.body, body);
    } finally {
        machine?.close();
        rmSync(directory, {recursive: true, force: true});
    }
});
