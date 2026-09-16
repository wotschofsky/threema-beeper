import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseHistoryPage, parseHistoryRequest, type NormalizedNodeMessage} from '../src/threema/history.ts';
import {encodeMessage, decodeMessage} from '../src/threema/message-codec.ts';
import {encodeMetadata, decodeMetadata} from '../src/threema/metadata-codec.ts';
import {parseDirectory} from '../src/threema/directory.ts';
import {parseConversations} from '../src/threema/conversations.ts';

await test('seeded malformed canonical/store inputs either reject safely or round-trip', {timeout: 60000}, (t) => {
    const seedText = process.env.FUZZ_SEED ?? '5eed2026';
    assert(/^[0-9a-f]{1,8}$/i.test(seedText), 'FUZZ_SEED must be up to eight hex digits');
    let seed = Number.parseInt(seedText, 16);
    assert(seed !== 0, 'Xorshift seed must not be zero');
    const iterations = Number(process.env.FUZZ_ITERATIONS ?? 5000);
    assert(Number.isInteger(iterations) && iterations >= 5000 && iterations <= 1000000);
    const random = (max: number) => {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        return (seed >>> 0) % max;
    };
    const keys = ['chatId', 'messages', 'ordinal', 'createdAt', 'content', 'reactions', 'next', 'contacts', 'groups', 'version', 'directory', 'chats', '__proto__'];
    function value(depth = 0): unknown {
        const kind = random(depth >= 4 ? 6 : 8);
        if (kind === 0) return null;
        if (kind === 1) return random(2) === 1;
        if (kind === 2) return [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, 0][random(5)];
        if (kind === 3) return ['0', '01', '1e3', '\u0000', '🙂', 'x'.repeat(100)][random(6)];
        if (kind === 4) return BigInt(random(100));
        if (kind === 5) return new Date(random(2) ? NaN : 0);
        if (kind === 6) return Array.from({length: random(6)}, () => value(depth + 1));
        const object: Record<string, unknown> = Object.create(null);
        for (let n = random(6); n > 0; n--) object[keys[random(keys.length)]!] = value(depth + 1);
        return object;
    }
    const message: NormalizedNodeMessage = {
        chatId: 'c:TEST1234', messageId: 'm:ffffffffffffffff', direction: 'inbound',
        senderIdentity: 'TEST1234', ordinal: 1n, createdAt: new Date(0), reactions: [],
        content: {type: 'text', text: 'Synthetic fuzz fixture'},
    };
    const encoded = encodeMessage(message);
    const metadata = encodeMetadata({directory: {contacts: [], groups: []}, chats: []});
    let accepted = 0; let rejected = 0;
    function exercise(parse: () => unknown, roundTrip: (parsed: any) => void, iteration: number) {
        let parsed: unknown;
        try { parsed = parse(); }
        catch (error) {
            assert(error instanceof Error, `Non-error rejection at iteration ${iteration}`);
            assert(!(error instanceof RangeError) && !(error instanceof TypeError), `Unexpected ${error.name} at iteration ${iteration}`);
            rejected++; return;
        }
        accepted++;
        roundTrip(parsed);
    }
    for (let iteration = 0; iteration < iterations; iteration++) {
        const malformed = value();
        const candidate = iteration % 10 === 0 ? message : {...message, [keys[random(keys.length)]!]: malformed};
        exercise(() => parseHistoryPage({messages: [candidate]}, {chatId: message.chatId, limit: 1}),
            page => assert.deepEqual(parseHistoryPage(page, {chatId: message.chatId, limit: 1}), page), iteration);
        exercise(() => parseHistoryRequest(iteration % 10 === 0 ? {chatId: message.chatId, limit: 1} : malformed),
            request => assert.deepEqual(parseHistoryRequest(request), request), iteration);
        exercise(() => parseDirectory(iteration % 10 === 0 ? {contacts: [], groups: []} : malformed),
            directory => assert.deepEqual(parseDirectory(directory), directory), iteration);
        exercise(() => parseConversations(iteration % 10 === 0 ? [] : malformed),
            chats => assert.deepEqual(parseConversations(chats), chats), iteration);
        const mutate = (text: string) => {
            const offset = random(text.length);
            return text.slice(0, offset) + ['{', ']', 'null', '"', '0', '\u0000'][random(6)] + text.slice(offset + 1);
        };
        exercise(() => decodeMessage(iteration % 10 === 0 ? encoded : mutate(encoded)),
            parsed => assert.deepEqual(decodeMessage(encodeMessage(parsed)), parsed), iteration);
        exercise(() => decodeMetadata(iteration % 10 === 0 ? metadata : mutate(metadata)),
            parsed => assert.deepEqual(decodeMetadata(encodeMetadata(parsed)), parsed), iteration);
    }
    assert(accepted > 3000 && rejected > 10000, 'Exercise both valid and rejected inputs');
    t.diagnostic(JSON.stringify({seed: seedText, iterations, accepted, rejected, calls: accepted + rejected}));
});

await test('conversation names have an aggregate UTF-8 bound', () => {
    const conversations = Array.from({length: 1000}, (_, n) => ({
        chatId: 'c:T' + n.toString().padStart(7, '0'), name: '界'.repeat(6000),
        unreadCount: 0, archived: false, pinned: false,
    }));
    assert.throws(() => parseConversations(conversations), /exceeds limits/);
    assert.equal(parseConversations(conversations.slice(0, 10)).length, 10);
});
