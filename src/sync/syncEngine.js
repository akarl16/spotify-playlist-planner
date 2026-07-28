import * as spotify from '../spotify.js';
import * as database from '../database.js';
import { CLASS_DATE_REGEX } from '../trackLibrary.js';
import { recordAttempt, recordSuccess, recordFailure, getPlaylistIdsNeedingRepair } from './syncState.js';
import { mapWithConcurrency } from './pool.js';

const LIBRARY_REGEX = /\[LIBRARY\]/;
const PAGE_SIZE = 50;

// Tuned by measurement, not guessed. Cold runs of the same 573-playlist library:
//   unbounded -> 459 failed, 462 rate-limit errors, ~30s
//   pool of 4 -> 166 failed, 166 rate-limit errors, ~70s
//   pool of 2 ->   0 failed,   0 errors of any kind, ~119s
// The extra ~50s over a pool of 4 buys correctness outright. Do not raise this
// without re-running a cold sync and confirming the rate-limited count stays zero.
const SYNC_CONCURRENCY = 2;

/**
 * Runs a full sync and returns the playlists the UI needs.
 *
 * STAGE 1 — deliberately preserves the existing network behavior so the baseline
 * measures the real problem. Specifically: unbounded fan-out, no retry, headers
 * fetched only when the store is empty, no pruning, and a repair phase that
 * reports its queue without executing. All of this changes in stage 2.
 */
async function runSync({ emit, spotifyClient = spotify }) {
    emit({ type: 'sync:start', at: Date.now() });

    const headers = await syncPlaylistHeaders({ emit, spotifyClient });

    const libraryHeaders = headers.filter(
        (playlist) => LIBRARY_REGEX.test(playlist.name) || LIBRARY_REGEX.test(playlist.description ?? '')
    );
    const classHeaders = headers.filter((playlist) => CLASS_DATE_REGEX.test(playlist.name));

    // Publish both totals before either phase starts. Without this the overall bar's
    // denominator grows as each phase begins, making it jump backwards mid-sync.
    emit({ type: 'phase:progress', phase: 'library', total: libraryHeaders.length });
    emit({ type: 'phase:progress', phase: 'class', total: classHeaders.length });

    const libraryPlaylists = await syncPlaylistBatch(libraryHeaders, 'library', { emit, spotifyClient });
    libraryPlaylists.sort((a, b) => a.name.localeCompare(b.name));

    const classPlaylists = await syncPlaylistBatch(classHeaders, 'class', { emit, spotifyClient });
    classPlaylists.sort((a, b) => b.name.localeCompare(a.name));

    await reportRepairQueue([...libraryHeaders, ...classHeaders], { emit });

    emit({ type: 'sync:complete', at: Date.now() });

    return { libraryPlaylists, classPlaylists };
}

async function syncPlaylistHeaders({ emit, spotifyClient }) {
    emit({ type: 'phase:start', phase: 'headers', total: 0, at: Date.now() });

    const stored = await database.getPlaylists();

    // STAGE 1: only fetches when the store is completely empty, exactly as today.
    // Stage 2 replaces this with a staleness window.
    if (stored.length > 0) {
        emit({ type: 'phase:progress', phase: 'headers', done: stored.length, total: stored.length });
        emit({ type: 'phase:complete', phase: 'headers', at: Date.now() });
        return stored;
    }

    const headers = [];
    let offset = 0;
    let more = true;

    while (more) {
        const page = await spotifyClient.getUserPlaylistsPage({
            limit: PAGE_SIZE,
            offset,
            onApiCall: (info) => emit({ type: 'api:call', phase: 'headers', rateLimited: info.rateLimited })
        });

        // Spotify intermittently returns nulls in this array.
        headers.push(...page.items.filter((playlist) => playlist != null));
        offset += page.items.length;
        more = page.next !== null;

        // phase:progress, not phase:start — the latter would reset `done` to 0 on
        // every page. The header phase counts playlists discovered, not fetched,
        // so nothing is pushed to the feed here.
        emit({ type: 'phase:progress', phase: 'headers', done: headers.length, total: page.total });
    }

    await database.setPlaylists(headers);
    emit({ type: 'phase:complete', phase: 'headers', at: Date.now() });

    return await database.getPlaylists();
}

async function syncPlaylistBatch(headers, phase, { emit, spotifyClient }) {
    emit({ type: 'phase:start', phase, total: headers.length, at: Date.now() });

    const playlists = await mapWithConcurrency(
        headers,
        SYNC_CONCURRENCY,
        (header) => syncOnePlaylist(header, phase, { emit, spotifyClient })
    );

    emit({ type: 'phase:complete', phase, at: Date.now() });
    return playlists;
}

async function syncOnePlaylist(header, phase, { emit, spotifyClient }) {
    const existing = await database.getPlaylist(header.id);

    // `.length`, NOT truthiness. An empty array means a previous run failed on the
    // first page; the old code treated [] as "already have it" and skipped these
    // forever, which is how 440 playlists ended up permanently empty.
    if (existing?.trackList?.length) {
        // Still emit progress, or the phase bar would never reach its total.
        emit({
            type: 'item:success',
            phase,
            playlistId: header.id,
            name: header.name,
            trackCount: existing.trackList.length,
            durationMs: 0,
            cached: true
        });
        return existing;
    }

    emit({ type: 'item:start', phase, playlistId: header.id, name: header.name });
    await recordAttempt(header.id);

    const startedAt = Date.now();
    const { trackList, fetchedItemCount, reachedEnd, error } = await fetchAllPlaylistItems(
        header.id, phase, { emit, spotifyClient }
    );

    // Partial data is still worth keeping — it just must never be called complete.
    const playlist = { ...header, trackList };
    await database.setPlaylist(playlist);

    const tracksTotal = header.tracks?.total ?? null;

    if (error) {
        await recordFailure(header.id, {
            error,
            fetchedItemCount,
            storedTrackCount: trackList.length,
            tracksTotal,
            snapshotId: header.snapshot_id
        });
        emit({
            type: 'item:error',
            phase,
            playlistId: header.id,
            name: header.name,
            cause: { kind: error.kind ?? 'http', status: error.status ?? 0 },
            storedTrackCount: trackList.length,
            tracksTotal
        });
        return playlist;
    }

    await recordSuccess(header.id, {
        snapshotId: header.snapshot_id,
        fetchedItemCount,
        storedTrackCount: trackList.length,
        tracksTotal,
        reachedEnd
    });
    emit({
        type: 'item:success',
        phase,
        playlistId: header.id,
        name: header.name,
        trackCount: trackList.length,
        durationMs: Date.now() - startedAt
    });

    return playlist;
}

async function fetchAllPlaylistItems(playlistId, phase, { emit, spotifyClient }) {
    const trackList = [];
    let fetchedItemCount = 0;
    let offset = 0;
    let more = true;
    let reachedEnd = false;
    let error = null;

    while (more) {
        let page;
        try {
            page = await spotifyClient.getPlaylistItems(playlistId, {
                limit: PAGE_SIZE,
                offset,
                onApiCall: (info) => emit({ type: 'api:call', phase, rateLimited: info.rateLimited })
            });
        } catch (err) {
            // STAGE 1: break without retrying, exactly as today. What is new is
            // that the caller now records WHY we stopped.
            error = err;
            break;
        }

        fetchedItemCount += page.items.length;

        // A zero-item page cannot advance `offset`, so a non-null `next` here would
        // spin forever. A legitimately empty playlist returns next === null and is
        // still a completed pagination.
        if (page.items.length === 0) {
            reachedEnd = page.next === null;
            break;
        }

        for (const entry of page.items) {
            // Nulls, local files, unavailable tracks, and podcast episodes.
            if (!entry?.item?.id) continue;

            trackList.push({
                id: entry.item.id,
                added_at: new Date(entry.added_at),
                name: entry.item.name,
                artists: entry.item.artists,
                duration_ms: entry.item.duration_ms
            });
        }

        offset += page.items.length;
        more = page.next !== null;
        if (!more) reachedEnd = true;
    }

    return { trackList, fetchedItemCount, reachedEnd, error };
}

// STAGE 1: reports what WOULD be repaired without repairing it. Executing here
// would fix the damage mid-baseline and destroy the measurement.
async function reportRepairQueue(inScopeHeaders, { emit }) {
    // Only library + class headers. The migration seeded syncState for ALL 628
    // stored playlists, including the 58 that are neither and are never fetched
    // by design — passing every header would inflate the repair queue with
    // playlists that are not damaged, just out of scope.
    const headersById = Object.fromEntries(inScopeHeaders.map((header) => [header.id, header]));
    const needingRepair = await getPlaylistIdsNeedingRepair(headersById);

    // phase:progress, not phase:start — the phase must stay visually `pending`
    // while still reporting its queue size, since it does no work in stage 1.
    emit({ type: 'phase:progress', phase: 'repair', total: needingRepair.length });
    return needingRepair;
}

export { runSync };
