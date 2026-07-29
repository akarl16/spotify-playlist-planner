import * as database from './database.js';

beforeEach(async () => {
    await database.init();
});

test('putTrackAudioFeaturesBatch writes every record and resolves after commit', async () => {
    await database.putTrackAudioFeaturesBatch([
        { id: 'a', tempo: 128, source: 'reccobeats' },
        { id: 'b', tempo: 95, source: 'reccobeats' }
    ]);

    expect(await database.getTrackAudioFeatures('a')).toMatchObject({ tempo: 128 });
    expect(await database.getTrackAudioFeatures('b')).toMatchObject({ tempo: 95 });
});

test('getTrackIdsMissingAudioFeatures returns only ids with no record', async () => {
    await database.putTrackAudioFeaturesBatch([{ id: 'known', tempo: 128, source: 'reccobeats' }]);

    const missing = await database.getTrackIdsMissingAudioFeatures(['known', 'unknown']);

    expect(missing).toEqual(['unknown']);
});

test('a recorded miss is NOT re-requested', async () => {
    // Without this, every sync would re-request ~1,930 known-absent tracks.
    await database.putTrackAudioFeaturesBatch([{ id: 'absent', source: 'reccobeats-notfound' }]);

    const missing = await database.getTrackIdsMissingAudioFeatures(['absent']);

    expect(missing).toEqual([]);
});

test('getAudioFeaturesMap returns only records carrying a tempo', async () => {
    await database.putTrackAudioFeaturesBatch([
        { id: 'a', tempo: 128, energy: 0.8, source: 'reccobeats' },
        { id: 'b', source: 'reccobeats-notfound' }
    ]);

    const map = await database.getAudioFeaturesMap(['a', 'b']);

    expect(map.get('a')).toMatchObject({ tempo: 128, energy: 0.8 });
    expect(map.has('b')).toBe(false);
});

test('getAudioFeaturesMap tolerates ids that were never stored', async () => {
    const map = await database.getAudioFeaturesMap(['never-seen']);

    expect(map.size).toBe(0);
});

test('an empty batch is a no-op', async () => {
    await expect(database.putTrackAudioFeaturesBatch([])).resolves.toBeUndefined();
});
