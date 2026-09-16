import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutboxStore} from '../src/outbox/store.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {ReactionIngress} from '../src/outbox/reaction-ingress.ts';
import {MatrixOutboxIngress} from '../src/outbox/matrix-ingress.ts';
import {MediaIngress} from '../src/outbox/media-ingress.ts';

await test('reaction ingress waits across text ingestion and send confirmation, then commits before acknowledgement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reaction-ingress-'));
    const key = randomBytes(32);
    const outbox = new OutboxStore(join(directory, 'outbox.sqlite'), key);
    const inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    const portals = new PortalStore(join(directory, 'portals.sqlite'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!chat:invalid';
    const options = {profile, owner, outbox, inbox, portals};
    try {
        portals.bind(profile, 'c:ABCD1234', room);
        const base = {room_id: room, sender: owner, encrypted: true};
        const reaction = {
            ...base,
            event_id: '$reaction',
            type: 'm.reaction',
            content: {'m.relates_to': {rel_type: 'm.annotation', event_id: '$text', key: '👍'}},
        };
        inbox.accept('transaction', {});
        inbox.complete('transaction', [
            {
                ...base,
                event_id: '$text',
                type: 'm.room.message',
                content: {msgtype: 'm.text', body: 'Hello'},
            },
            reaction,
        ]);
        assert.equal(new ReactionIngress(options).drain(), 0);
        assert.equal(outbox.rejection(profile, '$reaction'), undefined);
        assert.throws(() => new MatrixOutboxIngress(options).drain());
        assert.equal(new ReactionIngress(options).drain(), 0);
        const text = outbox.claim()!;
        const ids = ['m:0100000000000000'];
        outbox.recordIds(text.request.requestId, ids);
        assert.equal(new ReactionIngress(options).drain(), 0);
        outbox.sent(text.request.requestId, ids);
        // Model a process stopping after journal commit but before inbox acknowledgement.
        outbox.reactions.prepare({
            profile,
            owner,
            room,
            event: '$reaction',
            chat: 'c:ABCD1234',
            target: '$text',
            emoji: '👍',
            messages: ids,
            action: 'apply',
        });
        assert.equal(new ReactionIngress(options).drain(), 1);
        assert.equal(inbox.pendingEvents().length, 0);
        assert.deepEqual(outbox.reactions.get(profile, '$reaction')!.states, ['PREPARED']);
        const rejected = {
            ...reaction,
            event_id: '$missing',
            content: {'m.relates_to': {...reaction.content['m.relates_to'], event_id: '$unknown'}},
        };
        inbox.accept('missing', {});
        inbox.complete('missing', [rejected]);
        assert.equal(new ReactionIngress(options).drain(), 0);
        assert.match(outbox.rejection(profile, '$missing')!.reason, /not available/);
        assert.equal(inbox.pendingEvents()[0]!.event_id, '$missing');
        assert.equal(outbox.reactions.get(profile, '$missing'), undefined);
        inbox.accept('forward', {});
        inbox.complete('forward', [
            {
                ...reaction,
                event_id: '$forward',
                content: {
                    'm.relates_to': {
                        rel_type: 'm.annotation',
                        event_id: '$future',
                        key: '👍',
                    },
                },
            },
            {
                ...base,
                event_id: '$future',
                type: 'm.room.message',
                content: {msgtype: 'm.text', body: 'Later'},
            },
        ]);
        new ReactionIngress(options).drain();
        assert.match(outbox.rejection(profile, '$forward')!.reason, /not available/);
        assert.throws(() => new MatrixOutboxIngress(options).drain());
        assert.ok(
            outbox.forEvent(profile, '$future'),
            'An invalid forward reaction cannot deadlock its target',
        );
    } finally {
        inbox.close();
        portals.close();
        outbox.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});

await test('reaction to a file waits for confirmed media IDs, including uncertain restart recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'file-reaction-')),
        key = randomBytes(32);
    let outbox = new OutboxStore(join(directory, 'outbox'), key);
    const inbox = new TransactionInbox(join(directory, 'inbox'), key);
    const portals = new PortalStore(join(directory, 'portals'), key);
    const profile = 'SELF1234',
        owner = '@owner:invalid',
        room = '!room:invalid',
        chat = 'c:ABCD1234';
    const options = () => ({outbox, inbox, portals, profile, owner});
    try {
        portals.bind(profile, chat, room);
        const base = {room_id: room, sender: owner, encrypted: true};
        inbox.accept('file', {});
        inbox.complete('file', [
            {
                ...base,
                event_id: '$file',
                type: 'm.room.message',
                content: {
                    msgtype: 'm.file',
                    body: 'file.bin',
                    info: {size: 3, mimetype: 'application/octet-stream'},
                    file: {
                        url: 'mxc://invalid/id',
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
            },
            {
                ...base,
                event_id: '$file-reaction',
                type: 'm.reaction',
                content: {'m.relates_to': {rel_type: 'm.annotation', event_id: '$file', key: '👍'}},
            },
        ]);
        assert.equal(new ReactionIngress(options()).drain(), 0);
        new MediaIngress({...options(), maximumBytes: 1024}).drain();
        assert.equal(new ReactionIngress(options()).drain(), 0);
        assert.equal(outbox.rejection(profile, '$file-reaction'), undefined);
        outbox.media.claim(profile, '$file');
        const id = 'm:0100000000000000';
        outbox.media.recordIds(profile, '$file', [id]);
        assert.equal(new ReactionIngress(options()).drain(), 0);
        outbox.close();
        outbox = new OutboxStore(join(directory, 'outbox'), key);
        outbox.recoverInterrupted();
        // Mapping can commit just before a crash interrupts recording the echo observation.
        portals.bindOwnerEcho({
            profile,
            chat,
            message: id,
            room,
            sender: owner,
            root: '$file',
            latest: '$file',
            digest: 'a'.repeat(64),
        });
        assert.equal(new ReactionIngress(options()).drain(), 0);
        assert.equal(outbox.rejection(profile, '$file-reaction'), undefined);
        outbox.media.observe(profile, chat, id);
        assert.equal(new ReactionIngress(options()).drain(), 1);
        const operation = outbox.reactions.get(profile, '$file-reaction')!.operation;
        assert.equal(operation.target, '$file');
        assert.deepEqual(operation.messages, [id]);
        assert.equal(new ReactionIngress(options()).drain(), 0);
    } finally {
        outbox.close();
        inbox.close();
        portals.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
