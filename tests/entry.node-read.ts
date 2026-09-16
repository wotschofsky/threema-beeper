import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const native = createRequire(import.meta.url)(
    '../.local/sources/threema-desktop/apps/desktop/build/headless-spike/entry.probe.cjs',
);
await test('native database reads only inbound messages through the cutoff, preserving later unread messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-read-'));
    const secret = randomBytes(32);
    const db = native
        .createNodeFactories(dir)
        .db(
            {config: native.ProbeDefaultConfig()},
            native.ProbeNoopLogger,
            {userIdentity: 'SELF1234'},
            native.ProbeDatabaseKey(Uint8Array.from(secret)),
            false,
        );
    try {
        const uid = db.createContact({
            type: native.ProbeReceiverType.CONTACT,
            identity: 'ECHOECHO',
            publicKey: new Uint8Array(32),
            createdAt: new Date(),
            firstName: 'Echo',
            lastName: '',
            colorIndex: 0,
            verificationLevel: 0,
            workVerificationLevel: 0,
            identityType: 0,
            acquaintanceLevel: 0,
            activityState: 0,
            featureMask: 0n,
            syncState: 0,
            category: 0,
            visibility: 0,
        });
        const receiver = {type: native.ProbeReceiverType.CONTACT, uid};
        const conversation = db.getConversationOfReceiver(receiver);
        const ids = [1, 2, 3].map((n) =>
            db.createTextMessage({
                id: BigInt(n),
                type: 'text',
                senderContactUid: n === 1 ? undefined : uid,
                conversationUid: conversation.uid,
                createdAt: new Date(n * 1000),
                threadId: 1n,
                reactions: [],
                history: [],
                text: 'fixture',
            }),
        );
        const cutoff = db.getMessageByUid(ids[1]).ordinal;
        const changes = db.markConversationAsRead(conversation.uid, new Date(9000), cutoff);
        assert.deepEqual(
            changes.map((m: any) => m.uid),
            [ids[1]],
        );
        assert.equal(db.getMessageByUid(ids[0]).readAt, undefined);
        assert.equal(db.getMessageByUid(ids[2]).readAt, undefined);
        assert.equal(db.getConversationOfReceiver(receiver).unreadMessageCount, 1);
        assert.deepEqual(db.markConversationAsRead(conversation.uid, new Date(10000), cutoff), []);
    } finally {
        db.close();
        secret.fill(0);
        rmSync(dir, {recursive: true, force: true});
    }
});
await test('native read controller preserves unread count and honors receipt privacy', () => {
    for (const publicReceipts of [true, false]) {
        let view = {unreadMessageCount: 3},
            sent = 0,
            reflected = 0;
        const context: any = {
            uid: 1,
            getMessage: () => ({get: () => ({view: {ordinal: 2}})}),
            lifetimeGuard: {
                run: (fn: any) =>
                    fn({
                        view: () => view,
                        update: (fn: any) => {
                            view = {...view, ...fn(view)};
                        },
                    }),
            },
            _services: {
                db: {
                    markConversationAsRead: (_uid: any, _at: any, ordinal: any) => {
                        assert.equal(ordinal, 2);
                        return [{id: 2n}];
                    },
                },
            },
            _markMessagesAsRead: () => {},
            _shouldSendReadReceipt: () => publicReceipts,
            _sendReadReceiptsToContact: () => {
                sent++;
            },
            _reflectMarkMessagesAsRead: () => {
                reflected++;
            },
        };
        native.ProbeConversationController.prototype._handleRead.call(context, 0, new Date(), 2n);
        assert.equal(view.unreadMessageCount, 2);
        assert.equal(sent, publicReceipts ? 1 : 0);
        assert.equal(reflected, publicReceipts ? 0 : 1);
    }
});
