/** Keep only the smallest requested window; the source may hold a much larger history. */
export function smallestHistoryWindow<T>(
    source: Iterable<T>,
    capacity: number,
    compare: (left: T, right: T) => number,
): T[] {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 501) {
        throw new Error('Invalid history window capacity');
    }
    // Max-heap: the largest retained candidate is replaced when a smaller one arrives.
    const heap: T[] = [];
    for (const item of source) {
        if (heap.length < capacity) {
            heap.push(item);
            let child = heap.length - 1;
            while (child > 0) {
                const parent = Math.floor((child - 1) / 2);
                if (compare(heap[parent]!, heap[child]!) >= 0) {
                    break;
                }
                [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
                child = parent;
            }
        } else if (compare(item, heap[0]!) < 0) {
            heap[0] = item;
            let parent = 0;
            while (parent * 2 + 1 < heap.length) {
                const left = parent * 2 + 1;
                const right = left + 1;
                const child = right < heap.length && compare(heap[right]!, heap[left]!) > 0
                    ? right : left;
                if (compare(heap[parent]!, heap[child]!) >= 0) {
                    break;
                }
                [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
                parent = child;
            }
        }
    }
    return heap.sort(compare);
}
