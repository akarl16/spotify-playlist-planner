import * as database from '../database.js';
import { runSync } from './syncEngine.js';
import { SYNC_STATUS } from './syncState.js';

function makeItem(id) {
    return {
        added_at: '2026-01-15T00:00:00Z',
        item: { id, name: 'Track ' + id, artists: [{ name: 'Artist' }], duration_ms: 200000 }
    };
}

const header = (id, name, total, snapshot = 's1') => ({
    id, name, description: '', snapshot_id: snapshot, tracks: { total }
});

// Minimal fake honouring the same contract as src/spotify.js.
function makeClient({ playlists, itemsByPlaylist, failOn = {} }) {
    return {
        getUserPlaylistsPage: async ({ offset = 0, onApiCall }) => {
            if (onApiCall) onApiCall({ status: 200, rateLimited: false });
            return { items: playlists.slice(offset, offset + 50), total: playlists.length, next: null };
        },
        getPlaylistItems: async (playlistId, { offset = 0, onApiCall }) => {
            const failure = failOn[playlistId];
            if (failure && offset === failure.atOffset) {
                if (onApiCall) onApiCall({ status: failure.status, rateLimited: failure.status === 429 });
                throw Object.assign(new Error('boom'), { kind: failure.kind, status: failure.status });
            }
            if (onApiCall) onApiCall({ status: 200, rateLimited: false });
            const all = itemsByPlaylist[playlistId] ?? [];
            const page = all.slice(offset, offset + 50);
            return { items: page, total: all.length, next: offset + page.length < all.length ? 'more' : null };
        }
    };
}

beforeEach(async () => {
    await database.init();
});

test('stores fetched tracks on the playlist record', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 2)],
        itemsByPlaylist: { lib: [makeItem('t1'), makeItem('t2')] }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    const stored = await database.getPlaylist('lib');
    expect(stored.trackList).toHaveLength(2);
    expect(stored.trackList[0]).toMatchObject({ id: 't1', name: 'Track t1', duration_ms: 200000 });
    expect(stored.trackList[0].added_at).toBeInstanceOf(Date);
});

test('a fully paginated playlist is marked complete', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getSyncState('lib')).status).toBe(SYNC_STATUS.COMPLETE);
});

test('a 429 mid-pagination marks the playlist incomplete, never complete', async () => {
    const items = Array.from({ length: 120 }, (_, i) => makeItem('t' + i));
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 120)],
        itemsByPlaylist: { lib: items },
        failOn: { lib: { atOffset: 50, status: 429, kind: 'rate_limit' } }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    const state = await database.getSyncState('lib');
    expect(state.status).toBe(SYNC_STATUS.INCOMPLETE);
    expect(state.lastError.kind).toBe('rate_limit');
    expect(state.storedTrackCount).toBe(50);
});

test('partial data from a 429 is still persisted, just not marked complete', async () => {
    const items = Array.from({ length: 120 }, (_, i) => makeItem('t' + i));
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 120)],
        itemsByPlaylist: { lib: items },
        failOn: { lib: { atOffset: 50, status: 429, kind: 'rate_limit' } }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getPlaylist('lib')).trackList).toHaveLength(50);
});

test('a 429 on the FIRST page stores an empty list marked failed, not complete', async () => {
    // Stage 0's dominant damage shape: 440 class playlists in exactly this state.
    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 41)],
        itemsByPlaylist: { cls: [makeItem('t1')] },
        failOn: { cls: { atOffset: 0, status: 429, kind: 'rate_limit' } }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    const state = await database.getSyncState('cls');
    expect(state.status).toBe(SYNC_STATUS.FAILED);
    expect(state.storedTrackCount).toBe(0);
});

test('a playlist holding an EMPTY trackList is re-fetched, not skipped', async () => {
    // The []-is-truthy bug: the old code skipped these forever.
    await database.setPlaylist({ ...header('cls', '2026-07-25 Ride', 1), trackList: [] });

    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { cls: [makeItem('t1')] }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getPlaylist('cls')).trackList).toHaveLength(1);
    expect((await database.getSyncState('cls')).status).toBe(SYNC_STATUS.COMPLETE);
});

test('a playlist that already has tracks is not re-fetched', async () => {
    await database.setPlaylist({
        ...header('cls', '2026-07-25 Ride', 1),
        trackList: [{ id: 'cached', name: 'Cached', artists: [], duration_ms: 1, added_at: new Date() }]
    });

    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { cls: [makeItem('t1')] }
    });
    const spy = jest.spyOn(client, 'getPlaylistItems');

    await runSync({ emit: () => {}, spotifyClient: client });

    expect(spy).not.toHaveBeenCalled();
    expect((await database.getPlaylist('cls')).trackList[0].id).toBe('cached');
});

test('STAGE 1: does not retry after a 429 — one attempt per playlist', async () => {
    const items = Array.from({ length: 120 }, (_, i) => makeItem('t' + i));
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 120)],
        itemsByPlaylist: { lib: items },
        failOn: { lib: { atOffset: 50, status: 429, kind: 'rate_limit' } }
    });
    const spy = jest.spyOn(client, 'getPlaylistItems');

    await runSync({ emit: () => {}, spotifyClient: client });

    // offset 0 succeeds, offset 50 throws, loop breaks. Exactly two calls.
    expect(spy).toHaveBeenCalledTimes(2);
});

test('playlist fetching is bounded by the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const playlists = Array.from({ length: 20 }, (_, i) => header(`p${i}`, `2026-01-${String(i + 1).padStart(2, '0')} Ride`, 1));
    const itemsByPlaylist = Object.fromEntries(playlists.map(p => [p.id, [makeItem('t1')]]));

    const client = makeClient({ playlists, itemsByPlaylist });
    const original = client.getPlaylistItems;
    client.getPlaylistItems = async (...args) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
            await new Promise((r) => setTimeout(r, 2));
            return await original(...args);
        } finally {
            inFlight--;
        }
    };

    await runSync({ emit: () => {}, spotifyClient: client });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
});

test('STAGE 1: repair phase reports its queue but does not execute', async () => {
    const items = Array.from({ length: 120 }, (_, i) => makeItem('t' + i));
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 120)],
        itemsByPlaylist: { lib: items },
        failOn: { lib: { atOffset: 50, status: 429, kind: 'rate_limit' } }
    });
    const events = [];

    await runSync({ emit: (e) => events.push(e), spotifyClient: client });

    const repairProgress = events.find(e => e.type === 'phase:progress' && e.phase === 'repair');
    expect(repairProgress.total).toBe(1);
    // No work was done in the repair phase, and it never claimed to be running.
    expect(events.some(e => e.phase === 'repair' && e.type === 'item:start')).toBe(false);
    expect(events.some(e => e.phase === 'repair' && e.type === 'phase:start')).toBe(false);
});

test('splits playlists into library and class buckets', async () => {
    const client = makeClient({
        playlists: [
            header('lib', '[LIBRARY] Main', 1),
            header('cls', '2026-07-25 Ride', 1),
            header('other', 'Random Mix', 1)
        ],
        itemsByPlaylist: { lib: [makeItem('t1')], cls: [makeItem('t1')], other: [makeItem('t9')] }
    });

    const result = await runSync({ emit: () => {}, spotifyClient: client });

    expect(result.libraryPlaylists.map(p => p.id)).toEqual(['lib']);
    expect(result.classPlaylists.map(p => p.id)).toEqual(['cls']);
});

test('emits api:call for every request, tagged with its phase', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });
    const events = [];

    await runSync({ emit: (e) => events.push(e), spotifyClient: client });

    const apiCalls = events.filter(e => e.type === 'api:call');
    expect(apiCalls.some(e => e.phase === 'headers')).toBe(true);
    expect(apiCalls.some(e => e.phase === 'library')).toBe(true);
});

test('filters out null items, local files, and episodes', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 3)],
        itemsByPlaylist: {
            lib: [makeItem('t1'), { added_at: '2026-01-01T00:00:00Z', item: null }, null]
        }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getPlaylist('lib')).trackList).toHaveLength(1);
});

test('a cached playlist still advances phase progress to its total', async () => {
    await database.setPlaylist({
        ...header('cls', '2026-07-25 Ride', 1),
        trackList: [{ id: 'cached', name: 'Cached', artists: [], duration_ms: 1, added_at: new Date() }]
    });

    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { cls: [makeItem('t1')] }
    });
    const events = [];

    await runSync({ emit: (e) => events.push(e), spotifyClient: client });

    const success = events.find(e => e.type === 'item:success' && e.playlistId === 'cls');
    expect(success).toMatchObject({ cached: true, trackCount: 1 });
});

test('a zero-item page with a non-null next terminates instead of spinning', async () => {
    const client = {
        getUserPlaylistsPage: async ({ onApiCall }) => {
            if (onApiCall) onApiCall({ status: 200, rateLimited: false });
            return { items: [header('lib', '[LIBRARY] Main', 10)], total: 1, next: null };
        },
        // Pathological: claims more pages exist but returns nothing.
        getPlaylistItems: async (_playlistId, { onApiCall }) => {
            if (onApiCall) onApiCall({ status: 200, rateLimited: false });
            return { items: [], total: 10, next: 'more' };
        }
    };

    await runSync({ emit: () => {}, spotifyClient: client });

    // Terminated, and did not claim success.
    expect((await database.getSyncState('lib')).status).not.toBe('complete');
});

test('a legitimately empty playlist is recorded complete', async () => {
    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 0)],
        itemsByPlaylist: { cls: [] }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getSyncState('cls')).status).toBe('complete');
});

test('both fetch-phase totals are published before either phase starts', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1), header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')], cls: [makeItem('t2')] }
    });
    const events = [];

    await runSync({ emit: (e) => events.push(e), spotifyClient: client });

    const firstLibraryStart = events.findIndex(e => e.type === 'phase:start' && e.phase === 'library');
    const classTotalPublished = events.findIndex(e => e.type === 'phase:progress' && e.phase === 'class');

    // The class total must be known before the library phase begins, or the overall
    // bar's denominator grows mid-sync and the bar jumps backwards.
    expect(classTotalPublished).toBeGreaterThanOrEqual(0);
    expect(classTotalPublished).toBeLessThan(firstLibraryStart);
});
