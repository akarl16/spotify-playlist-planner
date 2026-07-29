import * as spotify from '../spotify.js';
import * as database from '../database.js';
import * as reccobeats from '../reccobeats.js';
import { CLASS_DATE_REGEX } from '../trackLibrary.js';
import { recordAttempt, recordSuccess, recordFailure, getPlaylistIdsNeedingRepair, needsSync } from './syncState.js';
import { mapWithConcurrency } from './pool.js';

const LIBRARY_REGEX = /\[LIBRARY\]/;
const PAGE_SIZE = 50;

// Playlists created in Spotify never appeared until the local store was emptied.
const HEADER_STALENESS_MS = 24 * 60 * 60 * 1000;
const HEADERS_SYNCED_AT_KEY = 'headers_synced_at';

function headersAreFresh(storedCount) {
    if (storedCount === 0) return false;
    const syncedAt = Number(localStorage.getItem(HEADERS_SYNCED_AT_KEY));
    if (!Number.isFinite(syncedAt) || syncedAt === 0) return false;
    // A negative age means the clock moved backwards or the stamp is from the
    // future. Treat that as stale: degrading toward a redundant fetch is safe,
    // degrading toward a silent skip is how playlists go missing.
    const age = Date.now() - syncedAt;
    return age >= 0 && age < HEADER_STALENESS_MS;
}

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
async function runSync({ emit, spotifyClient = spotify, reccoClient = reccobeats }) {
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
    const classPlaylists = await syncPlaylistBatch(classHeaders, 'class', { emit, spotifyClient });

    const repaired = await runRepairPhase([...libraryHeaders, ...classHeaders], { emit, spotifyClient });

    // Fold repaired records back in, or the UI would render pre-repair data until
    // the next reload.
    const merge = (playlists) => playlists.map((playlist) => repaired.get(playlist.id) ?? playlist);

    const mergedLibrary = merge(libraryPlaylists);
    const mergedClass = merge(classPlaylists);

    mergedLibrary.sort((a, b) => a.name.localeCompare(b.name));
    mergedClass.sort((a, b) => b.name.localeCompare(a.name));

    // Non-fatal by construction: a features failure must never cost the user their
    // playlists, which are already safely stored by this point.
    let featuresById = new Map();
    try {
        featuresById = await runFeaturesPhase([...mergedLibrary, ...mergedClass], { emit, reccoClient });
    } catch (error) {
        console.warn('Track tempo phase failed; continuing without it', error);
        emit({ type: 'phase:complete', phase: 'features', at: Date.now() });
    }

    emit({ type: 'sync:complete', at: Date.now() });

    return { libraryPlaylists: mergedLibrary, classPlaylists: mergedClass, featuresById };
}

async function syncPlaylistHeaders({ emit, spotifyClient }) {
    emit({ type: 'phase:start', phase: 'headers', total: 0, at: Date.now() });

    const stored = await database.getPlaylists();

    if (headersAreFresh(stored.length)) {
        emit({ type: 'phase:progress', phase: 'headers', done: stored.length, total: stored.length });
        emit({ type: 'phase:complete', phase: 'headers', at: Date.now() });
        return stored;
    }

    const headers = [];
    let offset = 0;
    let more = true;
    let sawNullEntries = false;

    while (more) {
        const page = await spotifyClient.getUserPlaylistsPage({
            limit: PAGE_SIZE,
            offset,
            onApiCall: (info) => emit({ type: 'api:call', phase: 'headers', rateLimited: info.rateLimited })
        });

        // Spotify intermittently returns nulls in this array.
        const pageItems = page.items.filter((playlist) => playlist != null);
        if (pageItems.length !== page.items.length) sawNullEntries = true;
        headers.push(...pageItems);
        offset += page.items.length;
        more = page.next !== null;

        // phase:progress, not phase:start — the latter would reset `done` to 0 on
        // every page. The header phase counts playlists discovered, not fetched,
        // so nothing is pushed to the feed here.
        emit({ type: 'phase:progress', phase: 'headers', done: headers.length, total: page.total });
    }

    await database.setPlaylists(headers);

    // Prune only when the listing is trustworthy. Spotify intermittently returns
    // nulls in this array, and deleting on a lossy response would destroy real
    // playlists along with their tracks and sync state — an empty-but-successful
    // response would wipe the entire cache. When in doubt, keep everything: a
    // lingering stale playlist is recoverable, a deleted one is not.
    if (headers.length > 0 && !sawNullEntries) {
        const liveIds = new Set(headers.map((header) => header.id));
        const staleIds = stored
            .map((playlist) => playlist.id)
            .filter((id) => !liveIds.has(id));

        if (staleIds.length > 0) {
            await database.deletePlaylists(staleIds);
        }
    } else {
        console.warn('Skipping playlist prune: header listing was empty or contained nulls');
    }

    localStorage.setItem(HEADERS_SYNCED_AT_KEY, String(Date.now()));

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

async function syncOnePlaylist(header, phase, { emit, spotifyClient, force = false }) {
    const existing = await database.getPlaylist(header.id);
    const existingState = await database.getSyncState(header.id);

    // `.length`, NOT truthiness. An empty array means a previous run failed on the
    // first page; the old code treated [] as "already have it" and skipped these
    // forever, which is how 440 playlists ended up permanently empty.
    //
    // `force` is how repair overrides this: a playlist under repair already holds
    // partial data, and that partial data is precisely what we are replacing.
    //
    // Skip only when we hold data AND the sync state says that data is current.
    // Testing trackList.length alone would skip a playlist whose snapshot changed
    // upstream — reporting stale tracks as a success, then quietly re-fetching the
    // same playlist in the repair phase moments later.
    if (!force && existing?.trackList?.length && !needsSync(existingState, header)) {
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
    //
    // But a FAILED fetch must never shrink what is already stored. Repair forces a
    // re-fetch of playlists that may already hold complete data (a changed
    // snapshot_id alone puts one in the queue), and a 429 on page one would
    // otherwise replace a full track list with []. A successful fetch is still
    // authoritative even when shorter, since tracks can be removed upstream.
    const existingCount = existing?.trackList?.length ?? 0;
    // Gate on `reachedEnd`, NOT on `error`. A fetch can end incomplete without
    // throwing — the zero-item-page guard breaks the loop with error === null — and
    // that path would otherwise overwrite good data with []. Any outcome that did
    // not paginate to the end is untrusted and must never shrink what is stored.
    // A completed fetch stays authoritative even when shorter, since tracks can be
    // removed upstream.
    const keepExisting = !reachedEnd && trackList.length < existingCount;
    const storedTrackList = keepExisting ? existing.trackList : trackList;

    const playlist = { ...header, trackList: storedTrackList };
    await database.setPlaylist(playlist);

    const tracksTotal = header.tracks?.total ?? null;

    if (error) {
        await recordFailure(header.id, {
            error,
            fetchedItemCount,
            storedTrackCount: storedTrackList.length,
            tracksTotal,
            snapshotId: header.snapshot_id
        });
        emit({
            type: 'item:error',
            phase,
            playlistId: header.id,
            name: header.name,
            cause: { kind: error.kind ?? 'http', status: error.status ?? 0 },
            storedTrackCount: storedTrackList.length,
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

// Re-fetches everything not known-good: incomplete, failed, never verified, or
// sitting at a stale snapshot. After the v3 migration that is the whole library,
// which is deliberate — a damaged playlist is indistinguishable from a healthy one
// from the inside, so none of the pre-existing cache is trusted.
async function runRepairPhase(inScopeHeaders, { emit, spotifyClient }) {
    // Only library + class headers. The migration seeded syncState for ALL 628
    // stored playlists, including the 58 that are neither and are never fetched
    // by design — passing every header would inflate the repair queue with
    // playlists that are not damaged, just out of scope.
    const headersById = Object.fromEntries(inScopeHeaders.map((header) => [header.id, header]));
    const needingRepair = await getPlaylistIdsNeedingRepair(headersById);
    const headers = needingRepair.map((id) => headersById[id]).filter(Boolean);

    emit({ type: 'phase:start', phase: 'repair', total: headers.length, at: Date.now() });

    const repaired = await mapWithConcurrency(
        headers,
        SYNC_CONCURRENCY,
        (header) => syncOnePlaylist(header, 'repair', { emit, spotifyClient, force: true })
    );

    emit({ type: 'phase:complete', phase: 'repair', at: Date.now() });

    return new Map(repaired.map((playlist) => [playlist.id, playlist]));
}

// Fifth phase: tempo and other audio features from ReccoBeats, keyed by Spotify
// track id. Measured coverage of this library is ~68%; misses are recorded so they
// are never re-requested, and the gap is surfaced in the UI rather than hidden.
//
// Deliberately non-fatal: playlists are the product, tempo is an enhancement. A
// ReccoBeats outage must not cost the user their library.
async function runFeaturesPhase(playlists, { emit, reccoClient }) {
    const trackIds = new Set();
    for (const playlist of playlists) {
        for (const track of playlist.trackList ?? []) {
            if (track?.id) trackIds.add(track.id);
        }
    }

    const allIds = Array.from(trackIds);
    const missing = await database.getTrackIdsMissingAudioFeatures(allIds);

    const batches = [];
    for (let i = 0; i < missing.length; i += reccobeats.RECCOBEATS_BATCH_SIZE) {
        batches.push(missing.slice(i, i + reccobeats.RECCOBEATS_BATCH_SIZE));
    }

    emit({ type: 'phase:start', phase: 'features', total: batches.length, at: Date.now() });

    await mapWithConcurrency(batches, SYNC_CONCURRENCY, async (batch, index) => {
        const startedAt = Date.now();
        const onApiCall = (info) => emit({ type: 'api:call', phase: 'features', rateLimited: info.rateLimited });

        try {
            const idMap = await reccoClient.resolveTrackIds(batch, { onApiCall });

            const featuresBySpotifyId = idMap.size > 0
                ? await reccoClient.fetchAudioFeatures(Array.from(idMap.values()), { onApiCall })
                : new Map();

            const records = batch.map((trackId) => {
                const features = featuresBySpotifyId.get(trackId);
                // A miss is stored, not skipped. Skipping would re-request every
                // known-absent track on every future sync.
                return features
                    ? { id: trackId, ...features, source: 'reccobeats' }
                    : { id: trackId, source: 'reccobeats-notfound' };
            });

            await database.putTrackAudioFeaturesBatch(records);

            emit({
                type: 'item:success', phase: 'features',
                playlistId: `features-${index}`, name: `${batch.length} tracks`,
                trackCount: featuresBySpotifyId.size, durationMs: Date.now() - startedAt
            });
        } catch (error) {
            emit({
                type: 'item:error', phase: 'features',
                playlistId: `features-${index}`, name: `${batch.length} tracks`,
                cause: { kind: error.kind ?? 'http', status: error.status ?? 0 },
                storedTrackCount: 0, tracksTotal: batch.length
            });
        }
    });

    emit({ type: 'phase:complete', phase: 'features', at: Date.now() });

    return await database.getAudioFeaturesMap(allIds);
}

export { runSync };
