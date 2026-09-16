import assert from 'node:assert/strict';
import {test} from 'node:test';
import {syncContactPicture} from '../src/matrix/contact-picture.ts';

await test('contact picture upload survives profile-update failure, is reused, and clears only bridge pictures', async () => {
    const botId = '@bot:matrix.invalid',
        owner = '@owner:matrix.invalid',
        ghostId = '@ghost:matrix.invalid';
    let picture: Uint8Array | null = new Uint8Array([255, 216, 255, 224]);
    let avatar: Record<string, unknown> = {url: 'mxc://matrix.invalid/fallback'};
    let profileAvatar = 'mxc://matrix.invalid/fallback';
    let failProfile = true,
        uploads = 0,
        reads = 0,
        roomWrites = 0;
    const marker = {
        type: 'm.bridge',
        state_key: 'threema://bridge',
        sender: botId,
        content: {creator: owner, network: {id: 'SELF1234'}, channel: {id: 'c:TEST1234'}},
    };
    const bot = {
        getRoomState: async () =>
            [
                marker,
                {
                    type: 'm.room.encryption',
                    state_key: '',
                    content: {algorithm: 'm.megolm.v1.aes-sha2'},
                },
                {type: 'm.room.avatar', state_key: '', content: avatar},
            ].map((event) => ({
                event_id: '$state',
                origin_server_ts: 0,
                room_id: '!chat:matrix.invalid',
                unsigned: {},
                sender: botId,
                ...event,
            })),
        uploadContent: async (bytes: Buffer, type?: string) => {
            uploads++;
            assert.equal(type, 'image/jpeg');
            assert.deepEqual(bytes, Buffer.from(picture!));
            return 'mxc://matrix.invalid/picture';
        },
        sendStateEvent: async (
            room: string,
            type: string,
            key: string,
            body: Record<string, unknown>,
        ) => {
            assert.equal(room, '!chat:matrix.invalid');
            assert.equal(type, 'm.room.avatar');
            assert.equal(key, '');
            roomWrites++;
            avatar = body;
            return '$avatar';
        },
    };
    const ghost = {
        getUserProfile: async () => ({avatar_url: profileAvatar}),
        setAvatarUrl: async (url: string) => {
            if (failProfile) {
                failProfile = false;
                throw new Error('synthetic profile failure');
            }
            profileAvatar = url;
        },
    };
    const options = {
        room: '!chat:matrix.invalid',
        profile: 'SELF1234',
        chat: 'c:TEST1234',
        owner,
        botId,
        ghostId,
        bot,
        ghost,
        read: async (id: string) => {
            assert.equal(id, 'TEST1234');
            reads++;
            return picture;
        },
    };
    await assert.rejects(syncContactPicture(options), /synthetic/);
    await syncContactPicture(options);
    await syncContactPicture(options);
    assert.equal(uploads, 1);
    assert.equal(roomWrites, 1);
    assert.equal(profileAvatar, avatar.url);
    picture = null;
    await syncContactPicture(options);
    assert.deepEqual(avatar, {});
    assert.equal(profileAvatar, '');
    avatar = {url: 'mxc://matrix.invalid/manually-set'};
    profileAvatar = String(avatar.url);
    await syncContactPicture(options);
    assert.equal(profileAvatar, 'mxc://matrix.invalid/manually-set');
    marker.content.creator = '@other:matrix.invalid';
    const before = reads;
    await assert.rejects(syncContactPicture(options), /verification/);
    assert.equal(reads, before);
    assert.equal(uploads, 1);
});

await test('group avatars use canonical group IDs and update the room without a contact ghost', async () => {
    const chat = 'g:SELF1234:0100000000000000';
    let avatar: Record<string, unknown> = {};
    let uploads = 0;
    const options = {
        room: '!group:matrix.invalid',
        profile: 'SELF1234',
        chat,
        owner: '@owner:matrix.invalid',
        botId: '@bot:matrix.invalid',
        bot: {
            getRoomState: async () =>
                [
                    {
                        type: 'm.bridge',
                        state_key: 'threema://bridge',
                        sender: '@bot:matrix.invalid',
                        content: {
                            creator: '@owner:matrix.invalid',
                            network: {id: 'SELF1234'},
                            channel: {id: chat},
                        },
                    },
                    {
                        type: 'm.room.encryption',
                        state_key: '',
                        content: {algorithm: 'm.megolm.v1.aes-sha2'},
                    },
                    {type: 'm.room.avatar', state_key: '', content: avatar},
                ] as any,
            uploadContent: async () => {
                uploads++;
                return 'mxc://matrix.invalid/group';
            },
            sendStateEvent: async (
                _room: string,
                _type: string,
                _key: string,
                content: Record<string, unknown>,
            ) => {
                avatar = content;
                return '$avatar';
            },
        },
        read: async (id: string) => {
            assert.equal(id, chat);
            return new Uint8Array([255, 216, 255, 224]);
        },
    };
    await syncContactPicture(options);
    await syncContactPicture(options);
    assert.equal(uploads, 1);
    assert.equal(avatar.url, 'mxc://matrix.invalid/group');
});
