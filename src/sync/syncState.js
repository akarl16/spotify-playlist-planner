import * as database from '../database.js';

const SYNC_STATUS = {
    NEVER: 'never',
    COMPLETE: 'complete',
    INCOMPLETE: 'incomplete',
    FAILED: 'failed'
};

function createSyncState(playlistId) {
    return {
        playlistId,
        snapshotId: null,
        status: SYNC_STATUS.NEVER,
        fetchedItemCount: 0,
        storedTrackCount: 0,
        tracksTotal: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        attempts: 0,
        lastError: null
    };
}

async function loadOrCreate(playlistId) {
    return (await database.getSyncState(playlistId)) ?? createSyncState(playlistId);
}

async function recordAttempt(playlistId) {
    const state = await loadOrCreate(playlistId);
    const next = { ...state, attempts: state.attempts + 1, lastAttemptAt: Date.now() };
    await database.putSyncState(next);
    return next;
}

// `reachedEnd` is the ONLY thing that makes a playlist complete. Comparing stored
// tracks against tracksTotal would wrongly flag every playlist containing a local
// file, an unavailable track, or a podcast episode.
async function recordSuccess(playlistId, { snapshotId, fetchedItemCount, storedTrackCount, tracksTotal, reachedEnd }) {
    const state = await loadOrCreate(playlistId);

    const next = {
        ...state,
        snapshotId,
        status: reachedEnd ? SYNC_STATUS.COMPLETE : SYNC_STATUS.INCOMPLETE,
        fetchedItemCount,
        storedTrackCount,
        tracksTotal,
        lastSuccessAt: reachedEnd ? Date.now() : state.lastSuccessAt,
        lastError: reachedEnd ? null : state.lastError
    };

    await database.putSyncState(next);
    return next;
}

async function recordFailure(playlistId, { error, fetchedItemCount, storedTrackCount, tracksTotal, snapshotId }) {
    const state = await loadOrCreate(playlistId);

    const next = {
        ...state,
        snapshotId,
        // Partial data is INCOMPLETE (repairable, some pages landed); nothing at
        // all is FAILED. Neither is ever COMPLETE.
        status: fetchedItemCount > 0 ? SYNC_STATUS.INCOMPLETE : SYNC_STATUS.FAILED,
        fetchedItemCount,
        storedTrackCount,
        tracksTotal,
        lastError: {
            kind: error?.kind ?? 'http',
            status: error?.status ?? 0,
            message: error?.message ?? String(error)
        }
    };

    await database.putSyncState(next);
    return next;
}

function needsSync(state, playlistHeader) {
    if (!state) return true;
    if (state.status !== SYNC_STATUS.COMPLETE) return true;
    return state.snapshotId !== playlistHeader.snapshot_id;
}

// Iterates HEADERS, not stored states: a playlist we have never attempted has no
// syncState row at all, and it still needs syncing. Driving off the state store
// would make that case invisible.
async function getPlaylistIdsNeedingRepair(playlistHeadersById) {
    const states = await database.getAllSyncStates();
    const stateByPlaylistId = new Map(states.map((state) => [state.playlistId, state]));

    return Object.values(playlistHeadersById)
        .filter((header) => needsSync(stateByPlaylistId.get(header.id), header))
        .map((header) => header.id);
}

export {
    SYNC_STATUS, createSyncState, recordAttempt, recordSuccess, recordFailure,
    needsSync, getPlaylistIdsNeedingRepair
};
