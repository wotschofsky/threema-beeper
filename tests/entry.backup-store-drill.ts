import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {serializeServiceConfig} from '../src/service/config-output.ts';
import {createHash, randomBytes} from 'node:crypto';
import {exportProxyRegistration} from '../src/service/proxy-registration.ts';
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {parseServiceConfig} from '../src/service/config.ts';
import {openBridgeResources} from '../src/service/resources.ts';
import {
    generateProfileSecret,
    saveProfileSecret,
    readProfileSecret,
} from '../src/setup/profile-secret.ts';
import {createBackup} from '../src/backup/create-backup.ts';
import {restoreBackup} from '../src/backup/restore-backup.ts';
import {adoptWorkspace} from '../src/backup/adopt-workspace.ts';
import type {MediaRequest} from '../src/outbox/media-journal.ts';
import type {MutationOperation} from '../src/outbox/mutation-journal.ts';
import {parseAudioProjection} from '../src/outbox/audio-projection.ts';
import {reconcileOutboundEcho} from '../src/outbox/echo.ts';
import type {NormalizedNodeMessage} from '../src/threema/history.ts';
import {
    OlmMachine,
    UserId,
    DeviceId,
    RoomId,
    EncryptionSettings,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/index.js';

await test('encrypted backup restores native Matrix identity and room keys while preserving uncertain outbound work', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'backup-store-drill-')));
    const data = join(root, 'original');
    await mkdir(data, {mode: 0o700});
    const config = parseServiceConfig(
        (await readFile('config.example.yaml', 'utf8'))
            .replaceAll('/data', data)
            .replace('/run/secrets/threema_profile_password', join(data, 'threema-key'))
            .replace('/run/secrets/matrix_crypto_store_key', join(data, 'matrix-key')),
    );
    config.owner = '@owner:beeper.com';
    config.matrix.domain = 'beeper.local';
    config.matrix.namespace = 'sh-threema';
    config.matrix.homeserver = 'https://matrix.beeper.com/_hungryserv/owner';
    const binary = join(root, 'synthetic-bbctl');
    const binaryBytes = Buffer.from('not executed: restore fixture');
    config.proxy = {
        binary,
        sha256: createHash('sha256').update(binaryBytes).digest('hex'),
        configFile: join(data, 'proxy-auth.json'),
        registrationFile: join(data, 'proxy-registration.yaml'),
    };
    const key = randomBytes(32);
    let expectedMatrixKey: Buffer | undefined;
    let machine: OlmMachine | undefined;
    let deviceIdentity: string | undefined;
    let encryptedEvent: string | undefined;
    const user = new UserId('@restore-fixture:example.invalid');
    const device = new DeviceId('RESTORE_FIXTURE');
    const room = new RoomId('!restore-fixture:example.invalid');
    try {
        saveProfileSecret(config.passwordFile, generateProfileSecret());
        saveProfileSecret(config.matrix.cryptoKeyFile, generateProfileSecret());
        await writeFile(binary, binaryBytes, {mode: 0o700});
        await writeFile(
            config.proxy.configFile,
            JSON.stringify({
                device_id: 'fixture',
                environments: {
                    prod: {
                        username: 'owner',
                        access_token: 'syt_synthetic-restore',
                        bridge_data_dir: data,
                    },
                },
            }),
            {mode: 0o600},
        );
        const mutation: MutationOperation = {
            profile: config.identity,
            owner: config.owner,
            room: '!mutation-backup:invalid',
            chat: 'c:MUTATE01',
            event: '$mutation-backup',
            target: '$mutation-original',
            commands: [1, 2, 3].map((part) => ({
                profile: config.identity,
                chatId: 'c:MUTATE01',
                messageId: `m:${part.toString(16).padStart(16, '0')}`,
                action: 'edit',
                text: 'private pending mutation',
            })),
        };
        const rejectedMutation: MutationOperation = {
            ...mutation,
            event: '$rejected-mutation',
            chat: 'c:MUTATE02',
            commands: mutation.commands.map((command) => ({...command, chatId: 'c:MUTATE02'})),
        };
        const notifiedMutation: MutationOperation = {
            ...rejectedMutation,
            event: '$notified-mutation',
        };
        const resources = openBridgeResources(config);
        const request = {
            requestId: '01900000-0000-7000-8000-000000000001',
            profile: config.identity,
            transactionId: 'synthetic-txn',
            eventId: '$synthetic-event',
            roomId: '!synthetic:invalid',
            sender: config.owner,
            chatId: 'c:TEST1234',
            text: 'private durable pending message',
        };
        const audio: MediaRequest = {
            id: '01900000-0000-7000-8000-000000000002',
            profile: config.identity,
            transaction: 'audio-backup-txn',
            event: '$audio-backup-event',
            room: '!audio-backup:invalid',
            owner: config.owner,
            media: {
                chat: 'c:TEST1234',
                kind: 'm.audio',
                filename: 'original.flac',
                mimeType: 'audio/flac',
                bytes: 12,
                file: {
                    url: 'mxc://invalid/backup-audio',
                    v: 'v2',
                    key: {
                        kty: 'oct',
                        alg: 'A256CTR',
                        key_ops: ['decrypt'],
                        k: Buffer.alloc(32).toString('base64url'),
                    },
                    iv: Buffer.alloc(16).toString('base64'),
                    hashes: {sha256: Buffer.alloc(32).toString('base64')},
                },
            },
        };
        const audioProjection = parseAudioProjection({
            kind: 'audio',
            fileName: 'threema-backup.m4a',
            mediaType: 'audio/mp4',
            bytes: 4321,
            durationSeconds: 0.25,
            caption: 'Private audio caption',
        });
        const audioMessageId = 'm:0100000000000000';
        const fallbackFiles = ['audio/mp4', 'audio/flac'].map((mime, index) => ({
            request: {
                ...audio,
                id: `01900000-0000-7000-8000-00000000000${index + 3}`,
                event: `$fallback-${index}`,
                room: `!fallback-${index}:invalid`,
                media: {...audio.media, chat: `c:FALL000${index}`},
            },
            projection: parseAudioProjection({
                kind: 'file',
                fileName: mime === 'audio/mp4' ? 'fallback.m4a' : 'original.flac',
                mediaType: mime,
                bytes: mime === 'audio/mp4' ? 1234 : 12,
                caption: 'Fallback caption',
            }),
            messageId: `m:0${index + 2}00000000000000`,
        }));
        try {
            await writeFile(
                config.matrix.registrationFile,
                JSON.stringify({
                    id: 'sh-threema',
                    url: 'http://127.0.0.1:29339',
                    as_token: 'synthetic-as',
                    hs_token: 'synthetic-hs',
                    sender_localpart: 'bridge_bot',
                    namespaces: {
                        users: [{regex: '^@sh-threema_.*:beeper\\.local$', exclusive: true}],
                        aliases: [],
                        rooms: [],
                    },
                }),
                {
                    mode: 0o600,
                },
            );
            await exportProxyRegistration(config, config.proxy.registrationFile);
            resources.inbox.accept('preserved-inbox', {fixture: 'durable payload'});
            resources.outbox.prepare(request);
            resources.outbox.claim(request.requestId);
            resources.outbox.mutations.prepare(mutation);
            assert(resources.outbox.mutations.claim(mutation.profile, mutation.event, 0));
            resources.outbox.mutations.finish(mutation.profile, mutation.event, 0, 'APPLIED');
            assert(resources.outbox.mutations.claim(mutation.profile, mutation.event, 1));
            for (const operation of [rejectedMutation, notifiedMutation]) {
                resources.outbox.mutations.prepare(operation);
                // The in-flight mutation blocks only its own chat.
                assert(resources.outbox.mutations.claim(operation.profile, operation.event, 0));
                resources.outbox.mutations.finish(
                    operation.profile,
                    operation.event,
                    0,
                    'REJECTED',
                    'edit-window-expired',
                );
            }
            resources.outbox.mutations.acknowledgeFailure(
                notifiedMutation.profile,
                notifiedMutation.event,
                0,
            );
            resources.portals.bind(audio.profile, audio.media.chat, audio.room);
            resources.outbox.media.prepare(audio);
            assert(resources.outbox.media.claim(audio.profile, audio.event));
            resources.outbox.media.recordAudioProjection(
                audio.profile,
                audio.event,
                audioProjection,
            );
            resources.outbox.media.recordIds(audio.profile, audio.event, [audioMessageId]);
            for (const fallback of fallbackFiles) {
                resources.portals.bind(
                    audio.profile,
                    fallback.request.media.chat,
                    fallback.request.room,
                );
                resources.outbox.media.prepare(fallback.request);
                assert(resources.outbox.media.claim(audio.profile, fallback.request.event));
                resources.outbox.media.recordAudioProjection(
                    audio.profile,
                    fallback.request.event,
                    fallback.projection,
                );
                resources.outbox.media.recordIds(audio.profile, fallback.request.event, [
                    fallback.messageId,
                ]);
            }
            expectedMatrixKey = Buffer.from(resources.matrixKey);
            machine = await OlmMachine.initialize(
                user,
                device,
                join(resources.matrixDirectory, 'restore-fixture'),
                resources.matrixKey.toString('base64'),
            );
            deviceIdentity = machine.identityKeys.ed25519.toBase64();
            await machine.shareRoomKey(room, [], new EncryptionSettings());
            const content = JSON.parse(
                await machine.encryptRoomEvent(
                    room,
                    'm.room.message',
                    JSON.stringify({msgtype: 'm.text', body: 'pre-backup encrypted message'}),
                ),
            );
            encryptedEvent = JSON.stringify({
                type: 'm.room.encrypted',
                event_id: '$before-backup',
                sender: user.toString(),
                origin_server_ts: 1,
                content,
            });
            machine.close();
            machine = undefined;
            await assert.rejects(createBackup(config, join(root, 'busy.enc'), key));
        } finally {
            resources.close();
        }
        const backup = join(root, 'backup.enc');
        await createBackup(config, backup, key);
        const workspace = join(root, 'restored');
        await restoreBackup(backup, workspace, key);
        const configFile = join(root, 'source-config.yaml');
        await writeFile(configFile, serializeServiceConfig(config), {mode: 0o600});
        for (const phase of ['data-synchronized', 'configuration-published']) {
            const target = join(root, 'killed-' + phase);
            const child = spawnSync(
                process.execPath,
                [
                    '--input-type=module',
                    '-e',
                    `
                import {adoptWorkspace} from './src/backup/adopt-workspace.ts';
                import {readServiceConfig} from './src/service/config.ts';
                const [workspace, configFile, destination, stopAt] = process.argv.slice(1);
                await adoptWorkspace(workspace, await readServiceConfig(configFile), destination, phase => {
                    if (phase === stopAt) process.kill(process.pid, 'SIGKILL');
                });
            `,
                    workspace,
                    configFile,
                    target,
                    phase,
                ],
                {encoding: 'utf8', timeout: 15000},
            );
            assert.equal(
                child.signal,
                'SIGKILL',
                `Synthetic adoption child failed: ${child.error?.message ?? ''} ${child.stderr?.toString() ?? ''}`,
            );
            if (phase === 'data-synchronized')
                await assert.rejects(access(join(target, 'bridge.yaml')));
            else {
                const published = parseServiceConfig(
                    await readFile(join(target, 'bridge.yaml'), 'utf8'),
                );
                const recovered = openBridgeResources(published);
                try {
                    assert.equal(recovered.inbox.next()?.id, 'preserved-inbox');
                } finally {
                    recovered.close();
                }
            }
            await assert.rejects(adoptWorkspace(workspace, config, target));
        }
        const invalidProxyTarget = join(root, 'invalid-proxy-installation');
        await assert.rejects(
            adoptWorkspace(
                workspace,
                {...config, proxy: {...config.proxy!, sha256: '0'.repeat(64)}},
                invalidProxyTarget,
            ),
        );
        await assert.rejects(access(invalidProxyTarget));
        const phases: string[] = [];
        const restoredConfig = await adoptWorkspace(
            workspace,
            config,
            join(root, 'installation'),
            (phase) => {
                phases.push(phase);
            },
        );
        assert.deepEqual(phases, ['data-synchronized', 'configuration-published']);
        const relocated = JSON.parse(await readFile(restoredConfig.proxy!.configFile, 'utf8'));
        assert.equal(
            relocated.environments.prod.bridge_data_dir,
            join(restoredConfig.dataDirectory, 'proxy'),
        );
        assert.equal(
            JSON.parse(await readFile(config.proxy.configFile, 'utf8')).environments.prod
                .bridge_data_dir,
            data,
        );

        await assert.rejects(access(join(root, 'installation/.bridge.yaml.pending')));
        const failed = join(root, 'failed-installation');
        await assert.rejects(
            adoptWorkspace(workspace, config, failed, (phase) => {
                if (phase === 'data-synchronized') throw new Error('synthetic publication failure');
            }),
        );
        await assert.rejects(access(failed));

        assert.deepEqual(
            parseServiceConfig(await readFile(join(root, 'installation/bridge.yaml'), 'utf8')),
            restoredConfig,
        );
        await assert.rejects(adoptWorkspace(workspace, config, join(root, 'installation')));
        assert(
            readProfileSecret(restoredConfig.passwordFile) ===
                readProfileSecret(config.passwordFile),
        );
        const reopened = openBridgeResources(restoredConfig);
        try {
            assert.equal(reopened.checkHealth(), true);
            assert(reopened.matrixKey.equals(expectedMatrixKey!));
            machine = await OlmMachine.initialize(
                user,
                device,
                join(reopened.matrixDirectory, 'restore-fixture'),
                reopened.matrixKey.toString('base64'),
            );
            assert.equal(machine.identityKeys.ed25519.toBase64(), deviceIdentity);
            const decrypted = JSON.parse(
                (await machine.decryptRoomEvent(encryptedEvent!, room)).event,
            );
            assert.equal(decrypted.content.body, 'pre-backup encrypted message');
            machine.close();
            machine = undefined;
            assert.equal(reopened.inbox.next()?.id, 'preserved-inbox');
            assert.equal(reopened.outbox.get(request.requestId)?.state, 'DISPATCHING');
            reopened.outbox.recoverInterrupted();
            assert.deepEqual(
                reopened.outbox.mutations.get(mutation.profile, mutation.event)?.operation,
                mutation,
            );
            assert.deepEqual(
                reopened.outbox.mutations.get(mutation.profile, mutation.event)?.states,
                ['APPLIED', 'OUTCOME_UNKNOWN', 'PREPARED'],
            );
            assert.equal(
                reopened.outbox.mutations.claim(mutation.profile, mutation.event, 1),
                false,
            );
            assert.equal(
                reopened.outbox.mutations.claim(mutation.profile, mutation.event, 2),
                false,
            );
            assert.equal(reopened.outbox.mutations.peek(mutation.profile), undefined);
            for (const operation of [rejectedMutation, notifiedMutation]) {
                assert.deepEqual(
                    reopened.outbox.mutations.get(operation.profile, operation.event)?.states,
                    ['REJECTED', 'CANCELLED', 'CANCELLED'],
                );
            }
            const mutationNotices = reopened.outbox.mutations.pendingFailures(mutation.profile, 10);
            assert.deepEqual(
                mutationNotices.map(({operation}) => operation.event),
                [rejectedMutation.event],
            );
            assert.equal(mutationNotices[0]?.reason, 'edit-window-expired');
            assert.equal(mutationNotices[0]?.cancelled, 2);
            assert.equal(reopened.outbox.get(request.requestId)?.state, 'OUTCOME_UNKNOWN');
            assert.equal(
                reopened.outbox.claim(),
                undefined,
                'Restore must not resend uncertain work',
            );
            assert.deepEqual(
                reopened.outbox.media.audioProjection(audio.profile, audio.event),
                audioProjection,
            );
            assert.equal(
                reopened.outbox.media.get(audio.profile, audio.event)?.state,
                'OUTCOME_UNKNOWN',
            );
            assert.deepEqual(reopened.outbox.media.get(audio.profile, audio.event)?.ids, [
                audioMessageId,
            ]);
            assert.equal(
                reopened.outbox.media.next(audio.profile),
                undefined,
                'Restored audio must not be resent',
            );
            const echo: NormalizedNodeMessage = {
                direction: 'outbound',
                senderIdentity: audio.profile,
                chatId: audio.media.chat,
                messageId: audioMessageId,
                createdAt: new Date(1000),
                sentAt: new Date(1000),
                ordinal: 1n,
                reactions: [],
                content: {
                    type: 'audio',
                    fileName: audioProjection.fileName,
                    mimeType: audioProjection.mediaType,
                    byteSize: audioProjection.bytes,
                    durationSeconds: audioProjection.durationSeconds,
                    caption: audioProjection.caption,
                },
            };
            assert.throws(() =>
                reconcileOutboundEcho(
                    reopened.outbox,
                    reopened.portals,
                    audio.profile,
                    audio.owner,
                    {
                        ...echo,
                        content: {...echo.content, durationSeconds: 0.5},
                    } as NormalizedNodeMessage,
                ),
            );
            assert.equal(
                reopened.outbox.media.get(audio.profile, audio.event)?.state,
                'OUTCOME_UNKNOWN',
            );
            assert(
                reconcileOutboundEcho(
                    reopened.outbox,
                    reopened.portals,
                    audio.profile,
                    audio.owner,
                    echo,
                ),
            );
            assert.equal(reopened.outbox.media.get(audio.profile, audio.event)?.state, 'SENT');
            assert.equal(
                reopened.portals.messageForEvent(audio.profile, audio.media.chat, audio.event),
                audioMessageId,
            );
            assert(
                reconcileOutboundEcho(
                    reopened.outbox,
                    reopened.portals,
                    audio.profile,
                    audio.owner,
                    echo,
                ),
            );
            for (const fallback of fallbackFiles) {
                assert.deepEqual(
                    reopened.outbox.media.audioProjection(audio.profile, fallback.request.event),
                    fallback.projection,
                );
                assert.equal(
                    reopened.outbox.media.get(audio.profile, fallback.request.event)?.state,
                    'OUTCOME_UNKNOWN',
                );
                assert.deepEqual(
                    reopened.outbox.media.get(audio.profile, fallback.request.event)?.ids,
                    [fallback.messageId],
                );
                assert.equal(reopened.outbox.media.next(audio.profile), undefined);
                const fileEcho: NormalizedNodeMessage = {
                    ...echo,
                    chatId: fallback.request.media.chat,
                    messageId: fallback.messageId,
                    content: {
                        type: 'file',
                        fileName: fallback.projection.fileName,
                        mimeType: fallback.projection.mediaType,
                        byteSize: fallback.projection.bytes,
                        caption: fallback.projection.caption,
                    },
                };
                assert(
                    reconcileOutboundEcho(
                        reopened.outbox,
                        reopened.portals,
                        audio.profile,
                        audio.owner,
                        fileEcho,
                    ),
                );
                assert.equal(
                    reopened.outbox.media.get(audio.profile, fallback.request.event)?.state,
                    'SENT',
                );
                assert.equal(
                    reopened.portals.messageForEvent(
                        audio.profile,
                        fallback.request.media.chat,
                        fallback.request.event,
                    ),
                    fallback.messageId,
                );
            }
        } finally {
            reopened.close();
        }
    } finally {
        machine?.close();
        key.fill(0);
        expectedMatrixKey?.fill(0);
        await rm(root, {recursive: true, force: true});
    }
});
