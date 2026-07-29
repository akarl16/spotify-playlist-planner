import * as database from '../database.js';
import { loadTrackFeatures } from './featuresLoader.js';

beforeEach(async () => {
    await database.init();
});

const noSleep = () => Promise.resolve();

test('fetches features for the given tracks and stores them', async () => {
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map([['t1', 'rb-1']])),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map([['t1', { tempo: 128 }]]))
    };

    const result = await loadTrackFeatures({ trackIds: ['t1'], reccoClient: recco, sleep: noSleep });

    expect(result.completed).toBe(true);
    expect(await database.getTrackAudioFeatures('t1')).toMatchObject({ tempo: 128, source: 'reccobeats' });
});

test('records a catalogue miss so it is never re-requested', async () => {
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map()),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };

    await loadTrackFeatures({ trackIds: ['t1'], reccoClient: recco, sleep: noSleep });

    expect(await database.getTrackAudioFeatures('t1')).toMatchObject({ source: 'reccobeats-notfound' });
});

test('skips tracks that already have a record', async () => {
    await database.putTrackAudioFeaturesBatch([{ id: 't1', tempo: 128, source: 'reccobeats' }]);
    const recco = { resolveTrackIds: jest.fn(), fetchAudioFeatures: jest.fn() };

    const result = await loadTrackFeatures({ trackIds: ['t1'], reccoClient: recco, sleep: noSleep });

    expect(recco.resolveTrackIds).not.toHaveBeenCalled();
    expect(result.batchesTotal).toBe(0);
});

test('reports progress per batch, carrying only that batch results', async () => {
    const ids = Array.from({ length: 95 }, (_, i) => `t${i}`);
    const recco = {
        resolveTrackIds: jest.fn(async (batch) => new Map(batch.map(id => [id, `rb-${id}`]))),
        fetchAudioFeatures: jest.fn(async (rbIds) => new Map(rbIds.map(rb => [rb.replace('rb-', ''), { tempo: 100 }])))
    };
    const progress = [];

    await loadTrackFeatures({
        trackIds: ids, reccoClient: recco, sleep: noSleep,
        onProgress: (p) => progress.push({ done: p.batchesDone, total: p.batchesTotal, size: p.features.size })
    });

    expect(progress).toHaveLength(3);
    expect(progress[2]).toMatchObject({ done: 3, total: 3 });
    expect(progress.reduce((n, p) => n + p.size, 0)).toBe(95);
});

test('stops between batches when cancelled and reports completed false', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `t${i}`);
    let calls = 0;
    const recco = {
        resolveTrackIds: jest.fn(async () => { calls++; return new Map(); }),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };

    const result = await loadTrackFeatures({
        trackIds: ids, reccoClient: recco, sleep: noSleep,
        isCancelled: () => calls >= 2
    });

    expect(result.completed).toBe(false);
    expect(calls).toBe(2);
});

test('a failing batch is counted but does not stop the run, and is not poisoned', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `t${i}`);
    let call = 0;
    const recco = {
        resolveTrackIds: jest.fn(async (batch) => {
            call++;
            if (call === 1) throw Object.assign(new Error('429'), { kind: 'rate_limit', status: 429 });
            return new Map(batch.map(id => [id, `rb-${id}`]));
        }),
        fetchAudioFeatures: jest.fn(async (rbIds) => new Map(rbIds.map(rb => [rb.replace('rb-', ''), { tempo: 90 }])))
    };

    const result = await loadTrackFeatures({ trackIds: ids, reccoClient: recco, sleep: noSleep });

    expect(result.failedBatches).toBe(1);
    expect(result.batchesDone).toBe(2);
    // Nothing written for the failed batch, so those ids retry next launch.
    expect(await database.getTrackAudioFeatures('t0')).toBeUndefined();
});

test('spaces batches out but does not pad the final one', async () => {
    const ids = Array.from({ length: 95 }, (_, i) => `t${i}`);
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map()),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };
    const sleep = jest.fn().mockResolvedValue(undefined);

    await loadTrackFeatures({ trackIds: ids, reccoClient: recco, sleep });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(120);
});

test('a single batch incurs no delay at all', async () => {
    // Boundary case for `index < batches.length - 1`: with one batch that is
    // `0 < 0`. Covered in spirit by the 3-batch test above, but n=1 is exactly
    // where an off-by-one would hide.
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map()),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };
    const sleep = jest.fn().mockResolvedValue(undefined);

    await loadTrackFeatures({ trackIds: ['t1'], reccoClient: recco, sleep });

    expect(recco.resolveTrackIds).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
});

test('an empty track list does no work', async () => {
    const recco = { resolveTrackIds: jest.fn(), fetchAudioFeatures: jest.fn() };

    const result = await loadTrackFeatures({ trackIds: [], reccoClient: recco, sleep: noSleep });

    expect(result).toMatchObject({ completed: true, batchesTotal: 0, added: 0 });
    expect(recco.resolveTrackIds).not.toHaveBeenCalled();
});
