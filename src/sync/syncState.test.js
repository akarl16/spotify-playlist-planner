import * as database from '../database.js';
import {
    SYNC_STATUS, createSyncState, recordAttempt, recordSuccess, recordFailure,
    needsSync, getPlaylistIdsNeedingRepair
} from './syncState.js';

beforeEach(async () => {
    await database.init();
});

test('a completed pagination run records complete', async () => {
    const state = await recordSuccess('pl-1', {
        snapshotId: 'snap-1',
        fetchedItemCount: 112,
        storedTrackCount: 110,
        tracksTotal: 112,
        reachedEnd: true
    });

    expect(state.status).toBe(SYNC_STATUS.COMPLETE);
    expect(state.lastError).toBeNull();
    expect(state.lastSuccessAt).toEqual(expect.any(Number));
});

test('a run that stopped before the last page records incomplete, NOT complete', async () => {
    const state = await recordSuccess('pl-1', {
        snapshotId: 'snap-1',
        fetchedItemCount: 50,
        storedTrackCount: 50,
        tracksTotal: 112,
        reachedEnd: false
    });

    expect(state.status).toBe(SYNC_STATUS.INCOMPLETE);
    expect(state.lastSuccessAt).toBeNull();
});

test('storing fewer tracks than tracksTotal is still complete when pagination finished', async () => {
    // Unavailable tracks, local files, and episodes are filtered out, so a healthy
    // playlist legitimately stores fewer tracks than its header reports.
    const state = await recordSuccess('pl-1', {
        snapshotId: 'snap-1',
        fetchedItemCount: 112,
        storedTrackCount: 98,
        tracksTotal: 112,
        reachedEnd: true
    });

    expect(state.status).toBe(SYNC_STATUS.COMPLETE);
});

test('a rate-limited failure that fetched some pages records incomplete with cause', async () => {
    const error = Object.assign(new Error('429'), { kind: 'rate_limit', status: 429 });

    const state = await recordFailure('pl-1', {
        error,
        fetchedItemCount: 50,
        storedTrackCount: 50,
        tracksTotal: 112,
        snapshotId: 'snap-1'
    });

    expect(state.status).toBe(SYNC_STATUS.INCOMPLETE);
    expect(state.lastError).toEqual({ kind: 'rate_limit', status: 429, message: '429' });
});

test('a failure that fetched nothing records failed', async () => {
    const error = Object.assign(new Error('boom'), { kind: 'network', status: 0 });

    const state = await recordFailure('pl-1', {
        error, fetchedItemCount: 0, storedTrackCount: 0, tracksTotal: 112, snapshotId: 'snap-1'
    });

    expect(state.status).toBe(SYNC_STATUS.FAILED);
});

test('recordAttempt increments attempts and stamps lastAttemptAt', async () => {
    await recordAttempt('pl-1');
    const state = await recordAttempt('pl-1');

    expect(state.attempts).toBe(2);
    expect(state.lastAttemptAt).toEqual(expect.any(Number));
});

test('needsSync is true when the playlist has never been synced', () => {
    expect(needsSync(createSyncState('pl-1'), { id: 'pl-1', snapshot_id: 'snap-1' })).toBe(true);
});

test('needsSync is false for a complete playlist at the same snapshot', () => {
    const state = { ...createSyncState('pl-1'), status: SYNC_STATUS.COMPLETE, snapshotId: 'snap-1' };

    expect(needsSync(state, { id: 'pl-1', snapshot_id: 'snap-1' })).toBe(false);
});

test('needsSync is true for a complete playlist whose snapshot changed', () => {
    const state = { ...createSyncState('pl-1'), status: SYNC_STATUS.COMPLETE, snapshotId: 'snap-1' };

    expect(needsSync(state, { id: 'pl-1', snapshot_id: 'snap-2' })).toBe(true);
});

test('needsSync is true for an incomplete playlist even at the same snapshot', () => {
    const state = { ...createSyncState('pl-1'), status: SYNC_STATUS.INCOMPLETE, snapshotId: 'snap-1' };

    expect(needsSync(state, { id: 'pl-1', snapshot_id: 'snap-1' })).toBe(true);
});

test('getPlaylistIdsNeedingRepair returns only playlists that are not complete', async () => {
    await recordSuccess('pl-good', {
        snapshotId: 'snap-1', fetchedItemCount: 10, storedTrackCount: 10, tracksTotal: 10, reachedEnd: true
    });
    await recordSuccess('pl-bad', {
        snapshotId: 'snap-2', fetchedItemCount: 50, storedTrackCount: 50, tracksTotal: 112, reachedEnd: false
    });

    const ids = await getPlaylistIdsNeedingRepair({
        'pl-good': { id: 'pl-good', snapshot_id: 'snap-1' },
        'pl-bad': { id: 'pl-bad', snapshot_id: 'snap-2' }
    });

    expect(ids).toEqual(['pl-bad']);
});

test('a header with no sync state at all is reported as needing repair', async () => {
    // Never attempted, so no syncState row exists. Driving off the state store
    // instead of the headers would make this playlist invisible forever.
    const ids = await getPlaylistIdsNeedingRepair({
        'pl-new': { id: 'pl-new', snapshot_id: 'snap-1' }
    });

    expect(ids).toEqual(['pl-new']);
});

test('a stored state with no matching header is ignored', async () => {
    // Deleted from Spotify: it has state but is no longer in the account.
    await recordSuccess('pl-gone', {
        snapshotId: 'snap-1', fetchedItemCount: 5, storedTrackCount: 5, tracksTotal: 5, reachedEnd: false
    });

    const ids = await getPlaylistIdsNeedingRepair({
        'pl-live': { id: 'pl-live', snapshot_id: 'snap-2' }
    });

    expect(ids).toEqual(['pl-live']);
});
