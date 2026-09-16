import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ownerReadEvents, OwnerReadReceipts} from '../src/matrix/owner-read-receipts.ts';
import {TransactionInbox} from '../src/matrix/transaction-inbox.ts';
import {PortalStore} from '../src/matrix/portal-store.ts';
import {MessageJournal} from '../src/threema/message-journal.ts';
const owner = '@owner:invalid',
    profile = 'SELF1234',
    room = '!room:invalid',
    chat = 'c:ECHOECHO';
const body = (event: string, kind = 'm.read', reader = owner, thread?: string) => ({
    'de.sorunome.msc2409.ephemeral': [
        {
            type: 'm.receipt',
            room_id: room,
            content: {
                [event]: {[kind]: {[reader]: {ts: 1, ...(thread ? {thread_id: thread} : {})}}},
            },
        },
    ],
});
await test('receipts accept only public main-timeline owner reads and deduplicate replays', () => {
    assert.equal(ownerReadEvents(body('$target'), owner).length, 1);
    assert.deepEqual(
        ownerReadEvents({ephemeral: body('$target')['de.sorunome.msc2409.ephemeral']}, owner),
        ownerReadEvents(body('$target'), owner),
    );
    assert.deepEqual(
        ownerReadEvents(body('$target'), owner),
        ownerReadEvents(body('$target'), owner),
    );
    for (const input of [
        body('$target', 'm.read.private'),
        body('$target', 'm.read', '@stranger:invalid'),
        body('$target', 'm.read', owner, '$thread'),
        body('invalid'),
        null,
    ])
        assert.deepEqual(ownerReadEvents(input, owner), []);
});
await test('read requests survive offline restart, retry uncertainty, and never regress their cutoff', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'owner-reads-')),
        key = randomBytes(32);
    let inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
    const portals = new PortalStore(join(directory, 'portals.sqlite'), key),
        journal = new MessageJournal(join(directory, 'journal.sqlite'), key, profile);
    let ready = false,
        allowed = false,
        loseResponse = true;
    const calls: string[] = [];
    const options = () => ({
        profile,
        owner,
        inbox,
        portals,
        journal,
        ready: () => ready,
        authorize: async () => {
            if (!allowed) throw Error('not joined');
        },
        markRead: async (request: any) => {
            calls.push(request.messageId);
            if (loseResponse) throw Error('lost reply');
        },
    });
    const accept = (id: string) => {
        inbox.accept(id, body(id));
        inbox.complete(id, ownerReadEvents(body(id), owner));
    };
    try {
        portals.bind(profile, chat, room);
        for (let n = 1; n <= 3; n++) {
            const id = `m:0${n}00000000000000`;
            journal.upsert({
                chatId: chat,
                messageId: id,
                direction: 'inbound',
                senderIdentity: 'ECHOECHO',
                createdAt: new Date(n),
                ordinal: BigInt(n),
                reactions: [],
                content: {type: 'text', text: 'fixture'},
            });
            portals.bindOwnerEcho({
                profile,
                chat,
                message: id,
                room,
                sender: owner,
                root: `$${n}`,
                latest: `$${n}`,
                digest: 'fixture',
            });
        }
        portals.bindReadTarget(profile, chat, '$status2', 'm:0200000000000000');
        accept('$status2');
        assert.equal(await new OwnerReadReceipts(options()).drain(), 0);
        inbox.close();
        inbox = new TransactionInbox(join(directory, 'inbox.sqlite'), key);
        let worker = new OwnerReadReceipts(options());
        ready = true;
        await assert.rejects(worker.drain(), /retry/);
        assert.deepEqual(calls, []);
        allowed = true;
        await assert.rejects(worker.drain(), /retry/);
        assert.equal(portals.receiptPosition(profile, chat, owner), undefined);
        loseResponse = false;
        worker = new OwnerReadReceipts(options());
        await worker.drain();
        assert.deepEqual(calls, ['m:0200000000000000', 'm:0200000000000000']);
        assert.equal(portals.receiptPosition(profile, chat, owner)?.ordinal, '2');
        accept('$1');
        await worker.drain();
        assert.equal(calls.length, 2);
        assert.equal(inbox.pendingEvents().length, 0);
        assert.equal(journal.message(chat, 'm:0300000000000000')?.readAt, undefined);
    } finally {
        inbox.close();
        portals.close();
        journal.close();
        key.fill(0);
        rmSync(directory, {recursive: true, force: true});
    }
});
