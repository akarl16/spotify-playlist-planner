import { mapWithConcurrency } from './pool.js';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

test('resolves results in input order regardless of completion order', async () => {
    const items = [30, 10, 20];
    const result = await mapWithConcurrency(items, 3, async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
    });

    expect(result).toEqual([30, 10, 20]);
});

test('never runs more than `limit` workers at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
    });

    expect(peak).toBe(4);
});

test('starts a queued item as soon as a slot frees, not in fixed batches', async () => {
    // Batching would leave 3 slots idle while the slow item runs.
    const gates = [deferred(), deferred(), deferred()];
    const started = [];
    const items = [0, 1, 2, 3, 4];

    const run = mapWithConcurrency(items, 2, async (i) => {
        started.push(i);
        if (i < 3) await gates[i].promise;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    gates[0].resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    await run;
    expect(started).toEqual([0, 1, 2, 3, 4]);
});

test('a rejecting worker does not stall the remaining queue', async () => {
    const completed = [];
    const items = [0, 1, 2, 3, 4, 5];

    await expect(mapWithConcurrency(items, 2, async (i) => {
        if (i === 1) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 1));
        completed.push(i);
    })).rejects.toThrow('boom');

    // Give any orphaned workers a chance to settle before asserting.
    await new Promise((r) => setTimeout(r, 20));
    expect(completed).not.toHaveLength(0);
});

test('an empty input resolves to an empty array without invoking the worker', async () => {
    const worker = jest.fn();

    await expect(mapWithConcurrency([], 4, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
});

test('a limit larger than the input runs everything without error', async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (n) => n * 2);

    expect(result).toEqual([2, 4]);
});

test('passes the index to the worker', async () => {
    const seen = [];

    await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, index) => { seen.push([item, index]); });

    expect(seen.sort()).toEqual([['a', 0], ['b', 1], ['c', 2]]);
});
