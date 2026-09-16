import assert from 'node:assert/strict';
import {test} from 'node:test';
import {smallestHistoryWindow} from '../integrations/threema/overlay/src/headless/node-history-window.ts';

await test('bounded history window matches full sort with ties and adversarial order', () => {
    const compare = (a: {ordinal: bigint; id: string}, b: {ordinal: bigint; id: string}) =>
        a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : a.id.localeCompare(b.id);
    const rows = Array.from({length: 100000}, (_, n) => ({
        ordinal: BigInt((n * 7919) % 997), id: n.toString(16).padStart(16, '0'),
    }));
    const sorted = rows.slice().sort(compare);
    for (const capacity of [1, 2, 100, 501]) {
        for (const source of [rows, sorted, sorted.slice().reverse()])
            assert.deepEqual(smallestHistoryWindow(source.values(), capacity, compare), sorted.slice(0, capacity));
    }
    assert.deepEqual(smallestHistoryWindow([], 1, compare), []);
    assert.deepEqual(smallestHistoryWindow(rows.slice(0, 2), 501, compare), rows.slice(0, 2).sort(compare));
    for (const capacity of [0, -1, 502, NaN, 1.5])
        assert.throws(() => smallestHistoryWindow(rows, capacity, compare));
});
