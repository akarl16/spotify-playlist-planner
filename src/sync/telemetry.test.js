import { initialTelemetry, reduceTelemetry, PHASES, FEED_LIMIT } from './telemetry.js';

const apply = (events, state = initialTelemetry()) => events.reduce(reduceTelemetry, state);

test('starts with every phase pending and zeroed stats', () => {
    const state = initialTelemetry();

    expect(state.running).toBe(false);
    expect(state.phases).toHaveLength(PHASES.length);
    expect(state.phases.every(p => p.status === 'pending')).toBe(true);
    expect(state.stats).toEqual({ apiCalls: 0, rateLimited: 0, failed: 0, tracksCached: 0 });
});

test('sync:start marks running and stamps startedAt', () => {
    const state = apply([{ type: 'sync:start', at: 1000 }]);

    expect(state.running).toBe(true);
    expect(state.startedAt).toBe(1000);
});

test('phase:start sets the phase active with its total', () => {
    const state = apply([{ type: 'sync:start', at: 0 }, { type: 'phase:start', phase: 'class', total: 306 }]);
    const phase = state.phases.find(p => p.key === 'class');

    expect(phase.status).toBe('active');
    expect(phase.total).toBe(306);
    expect(phase.done).toBe(0);
});

test('item:success increments done and tracksCached', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 2 },
        { type: 'item:success', phase: 'class', playlistId: 'a', name: 'A', trackCount: 46, durationMs: 310 }
    ]);

    expect(state.phases.find(p => p.key === 'class').done).toBe(1);
    expect(state.stats.tracksCached).toBe(46);
});

test('item:error increments the phase failure count and global failed stat', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 2 },
        {
            type: 'item:error', phase: 'class', playlistId: 'b', name: 'B',
            cause: { kind: 'rate_limit', status: 429 }, storedTrackCount: 50, tracksTotal: 112
        }
    ]);

    expect(state.phases.find(p => p.key === 'class').failed).toBe(1);
    expect(state.stats.failed).toBe(1);
});

test('item:error records an incomplete entry describing the cause', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 1 },
        {
            type: 'item:error', phase: 'class', playlistId: 'b', name: '2026-07-10 Recovery',
            cause: { kind: 'rate_limit', status: 429 }, storedTrackCount: 50, tracksTotal: 112
        }
    ]);

    expect(state.incomplete).toEqual([{
        playlistId: 'b',
        name: '2026-07-10 Recovery',
        cause: { kind: 'rate_limit', status: 429 },
        storedTrackCount: 50,
        tracksTotal: 112
    }]);
});

test('api:call counts calls and rate limits, globally and per phase', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 1 },
        { type: 'api:call', phase: 'class', rateLimited: false },
        { type: 'api:call', phase: 'class', rateLimited: true }
    ]);

    expect(state.stats.apiCalls).toBe(2);
    expect(state.stats.rateLimited).toBe(1);
    expect(state.phases.find(p => p.key === 'class').apiCalls).toBe(2);
});

test('the feed keeps newest first and is capped', () => {
    const events = [{ type: 'sync:start', at: 0 }, { type: 'phase:start', phase: 'class', total: 100 }];
    for (let i = 0; i < FEED_LIMIT + 10; i++) {
        events.push({
            type: 'item:success', phase: 'class', playlistId: `p${i}`, name: `P${i}`,
            trackCount: 1, durationMs: 10
        });
    }

    const state = apply(events);

    expect(state.feed).toHaveLength(FEED_LIMIT);
    expect(state.feed[0].name).toBe(`P${FEED_LIMIT + 9}`);
});

test('phase:progress updates counts without resetting done or changing status', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'headers', total: 50 },
        { type: 'item:success', phase: 'headers', playlistId: 'a', name: 'A', trackCount: 0, durationMs: 1 },
        { type: 'phase:progress', phase: 'headers', total: 312 }
    ]);
    const phase = state.phases.find(p => p.key === 'headers');

    expect(phase.total).toBe(312);
    expect(phase.done).toBe(1);       // NOT reset
    expect(phase.status).toBe('active');
});

test('phase:progress on a pending phase leaves it pending', () => {
    // The stage 1 repair phase reports a queue size without claiming to be running.
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:progress', phase: 'repair', total: 2 }
    ]);
    const phase = state.phases.find(p => p.key === 'repair');

    expect(phase.total).toBe(2);
    expect(phase.status).toBe('pending');
});

test('phase:complete marks the phase done', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'headers', total: 1 },
        { type: 'phase:complete', phase: 'headers' }
    ]);

    expect(state.phases.find(p => p.key === 'headers').status).toBe('complete');
});

test('sync:error stops the run and records the cause', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'headers', total: 10 },
        { type: 'sync:error', cause: { kind: 'rate_limit', status: 429 }, message: 'Spotify API error: 429' }
    ]);

    expect(state.running).toBe(false);
    expect(state.fatalError).toEqual({ kind: 'rate_limit', status: 429, message: 'Spotify API error: 429' });
});

test('initial telemetry has no fatal error', () => {
    expect(initialTelemetry().fatalError).toBeNull();
});

test('tick updates elapsedMs while running', () => {
    const state = apply([{ type: 'sync:start', at: 1000 }, { type: 'tick', at: 4500 }]);

    expect(state.elapsedMs).toBe(3500);
});

test('sync:complete stops the run', () => {
    const state = apply([{ type: 'sync:start', at: 0 }, { type: 'sync:complete', at: 5000 }]);

    expect(state.running).toBe(false);
    expect(state.elapsedMs).toBe(5000);
});

test('a cached item:success advances progress without adding a feed row', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'library', total: 2 },
        { type: 'item:success', phase: 'library', playlistId: 'a', name: 'A', trackCount: 46, durationMs: 0, cached: true }
    ]);

    expect(state.phases.find(p => p.key === 'library').done).toBe(1);
    expect(state.stats.tracksCached).toBe(46);
    expect(state.feed).toHaveLength(0);
});

test('unknown events pass through without changing state', () => {
    const before = apply([{ type: 'sync:start', at: 0 }]);
    const after = reduceTelemetry(before, { type: 'nonsense' });

    expect(after).toBe(before);
});

test('the features phase exists and starts pending', () => {
    const phase = initialTelemetry().phases.find(p => p.key === 'features');

    expect(phase).toBeDefined();
    expect(phase.label).toBe('Track tempo');
    expect(phase.status).toBe('pending');
});

test('the features phase progresses like any other', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'features', total: 100 },
        { type: 'item:success', phase: 'features', playlistId: 'batch-0', name: 'batch 1', trackCount: 40, durationMs: 10 }
    ]);
    const phase = state.phases.find(p => p.key === 'features');

    expect(phase.status).toBe('active');
    expect(phase.done).toBe(1);
    expect(phase.total).toBe(100);
});
