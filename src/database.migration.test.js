import * as idb from 'idb';
import * as database from './database.js';

const sharedTrack = {
    id: 'track-shared',
    name: 'Shared Song',
    artists: [{ name: 'Artist A' }],
    duration_ms: 210000,
    added_at: new Date('2026-01-15T00:00:00Z')
};

// Builds a v2 database matching the pre-migration schema exactly.
async function seedV2Database() {
    const db = await idb.openDB('playlist-planner', 2, {
        upgrade(upgradeDb) {
            upgradeDb.createObjectStore('playlists', { keyPath: 'id' });
            upgradeDb.createObjectStore('tracksAudioFeatures', { keyPath: 'id' });
            upgradeDb.createObjectStore('artists', { keyPath: 'id' });
        }
    });

    await db.put('playlists', {
        id: 'pl-full',
        name: '2026-01-15 Ride',
        description: '',
        snapshot_id: 'snap-1',
        tracks: { total: 2 },
        owner: { id: 'akarl16', display_name: 'Adam' },
        unknownLegacyField: { nested: ['a', 'b'], keep: true },
        trackList: [
            sharedTrack,
            {
                id: 'track-only-1',
                name: 'Solo Song',
                artists: [{ name: 'Artist B' }],
                duration_ms: 180000,
                added_at: new Date('2026-01-16T00:00:00Z')
            }
        ]
    });

    // The dominant real-world damage shape: a first-page 429 stored [].
    await db.put('playlists', {
        id: 'pl-empty',
        name: '2026-02-01 Ride',
        description: '',
        snapshot_id: 'snap-2',
        tracks: { total: 41 },
        trackList: []
    });

    db.close();
}

test('migration creates the syncState store', async () => {
    await seedV2Database();
    await database.init();

    expect(await database.getAllSyncStates()).toHaveLength(2);
});

test('migration marks every pre-existing playlist as never synced', async () => {
    await seedV2Database();
    await database.init();

    for (const state of await database.getAllSyncStates()) {
        expect(state.status).toBe('never');
        expect(state.snapshotId).toBeNull();
        expect(state.lastError).toBeNull();
        expect(state.attempts).toBe(0);
    }
});

test('migration records tracksTotal and storedTrackCount for diagnostics', async () => {
    await seedV2Database();
    await database.init();

    expect(await database.getSyncState('pl-full')).toMatchObject({
        tracksTotal: 2, storedTrackCount: 2
    });
    expect(await database.getSyncState('pl-empty')).toMatchObject({
        tracksTotal: 41, storedTrackCount: 0
    });
});

test('migration leaves playlist records completely untouched', async () => {
    await seedV2Database();
    await database.init();

    const playlist = await database.getPlaylist('pl-full');

    // Track bodies stay embedded; nothing is normalized out.
    expect(playlist.trackList).toHaveLength(2);
    expect(playlist.trackList[0]).toEqual(sharedTrack);
    expect(playlist.trackList[0].added_at).toBeInstanceOf(Date);
    expect(playlist.trackRefs).toBeUndefined();
});

test('migration preserves fields it knows nothing about', () => {
    // Guards against a future regression that read-modify-writes playlist records
    // during the upgrade: any reshaping put() would drop unknown properties.
    return seedV2Database()
        .then(() => database.init())
        .then(() => database.getPlaylist('pl-full'))
        .then((playlist) => {
            expect(playlist.owner).toEqual({ id: 'akarl16', display_name: 'Adam' });
            expect(playlist.unknownLegacyField).toEqual({ nested: ['a', 'b'], keep: true });
        });
});

test('opens cleanly on a fresh database with no v2 data', async () => {
    await database.init();

    expect(await database.getPlaylists()).toEqual([]);
    expect(await database.getAllSyncStates()).toEqual([]);
});

test('setPlaylists resolves only after its writes are committed', async () => {
    await database.init();

    await database.setPlaylists([
        { id: 'a', name: 'A', snapshot_id: 's1', tracks: { total: 1 } },
        { id: 'b', name: 'B', snapshot_id: 's1', tracks: { total: 1 } }
    ]);

    // Would be flaky if setPlaylists returned before awaiting tx.done.
    expect(await database.getPlaylists()).toHaveLength(2);
});

test('setPlaylists preserves an existing trackList when snapshot_id is unchanged', async () => {
    await database.init();
    await database.setPlaylist({
        id: 'a', name: 'A', snapshot_id: 's1', tracks: { total: 1 }, trackList: [sharedTrack]
    });

    await database.setPlaylists([{ id: 'a', name: 'A renamed', snapshot_id: 's1', tracks: { total: 1 } }]);

    const stored = await database.getPlaylist('a');
    expect(stored.name).toBe('A renamed');
    expect(stored.trackList).toHaveLength(1);
});

test('setPlaylists clears the trackList when snapshot_id changed', async () => {
    await database.init();
    await database.setPlaylist({
        id: 'a', name: 'A', snapshot_id: 's1', tracks: { total: 1 }, trackList: [sharedTrack]
    });

    await database.setPlaylists([{ id: 'a', name: 'A', snapshot_id: 's2', tracks: { total: 1 } }]);

    expect((await database.getPlaylist('a')).trackList).toEqual([]);
});

test('deletePlaylists removes both the playlist and its sync state', async () => {
    await database.init();
    await database.setPlaylist({ id: 'a', name: 'A', snapshot_id: 's1', trackList: [] });
    await database.putSyncState({ playlistId: 'a', status: 'complete' });

    await database.deletePlaylists(['a']);

    expect(await database.getPlaylist('a')).toBeUndefined();
    expect(await database.getSyncState('a')).toBeUndefined();
});
