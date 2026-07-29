import { buildTrackLibrary } from './trackLibrary.js';

const NOW = new Date('2026-07-27T00:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000);

const track = (id, name, added_at) => ({
    id, name, artists: [{ name: 'Artist ' + id }], duration_ms: 200000, added_at
});

const libraryPlaylist = (trackList, name = '[LIBRARY] Main') => ({ id: 'lib-' + name, name, trackList });
const classPlaylist = (name, trackList) => ({ id: name, name, trackList });

test('flattens library playlist tracks into the library', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])], [], NOW
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 't1', name: 'Alpha', duration_ms: 200000 });
});

test('joins names of every library playlist a track appears on', () => {
    const result = buildTrackLibrary(
        [
            libraryPlaylist([track('t1', 'Alpha', daysAgo(10))], '[LIBRARY] One'),
            libraryPlaylist([track('t1', 'Alpha', daysAgo(9))], '[LIBRARY] Two')
        ],
        [], NOW
    );

    expect(result).toHaveLength(1);
    expect(result[0].lists).toBe('[LIBRARY] One,[LIBRARY] Two');
});

test('scores recency from the class playlist date, not from added_at', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(300))])],
        [classPlaylist('2026-07-25 Ride', [track('t1', 'Alpha', daysAgo(300))])],
        NOW
    );

    // 2026-07-25 is 2 days before NOW -> within 7 days -> 10 points.
    expect(result[0].recencyScore).toBe(10);
});

test('accumulates recency across multiple plays', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(300))])],
        [
            classPlaylist('2026-07-25 Ride', [track('t1', 'Alpha', daysAgo(2))]),   // 10
            classPlaylist('2026-07-01 Ride', [track('t1', 'Alpha', daysAgo(26))]),  // 5
            classPlaylist('2026-05-01 Ride', [track('t1', 'Alpha', daysAgo(87))])   // 2
        ],
        NOW
    );

    expect(result[0].recencyScore).toBe(17);
    expect(result[0].plays).toHaveLength(3);
});

test('ignores class-playlist tracks that are not in any library playlist', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])],
        [classPlaylist('2026-07-25 Ride', [track('t2', 'Beta', daysAgo(2))])],
        NOW
    );

    expect(result.map(t => t.id)).toEqual(['t1']);
    expect(result[0].plays).toHaveLength(0);
});

test('tolerates playlists with an empty track list', () => {
    // 440 playlists are in exactly this state until stage 2 repairs them.
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])],
        [classPlaylist('2026-07-25 Ride', [])],
        NOW
    );

    expect(result).toHaveLength(1);
    expect(result[0].recencyScore).toBe(0);
});

test('sorts by recency ascending, then by added_at descending', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([
            track('t1', 'Alpha', daysAgo(10)),
            track('t2', 'Beta', daysAgo(20))
        ])],
        [classPlaylist('2026-07-25 Ride', [track('t1', 'Alpha', daysAgo(2))])],
        NOW
    );

    // t2 has no plays (score 0) so it sorts ahead of t1 (score 10).
    expect(result.map(t => t.id)).toEqual(['t2', 't1']);
});

test('does not mutate the stored playlist objects it reads', () => {
    // This is the bug being fixed: the original decorated IndexedDB-loaded objects
    // in place, so a second call in one session accumulated duplicate list names.
    const stored = track('t1', 'Alpha', daysAgo(10));
    const storedInClass = track('t1', 'Alpha', daysAgo(10));
    const library = [libraryPlaylist([stored])];
    const classes = [classPlaylist('2026-07-25 Ride', [storedInClass])];

    buildTrackLibrary(library, classes, NOW);

    expect(stored).not.toHaveProperty('plays');
    expect(stored).not.toHaveProperty('lists');
    expect(stored).not.toHaveProperty('recencyScore');
    // The class date must NOT be written back over the stored added_at.
    expect(storedInClass.added_at).toEqual(daysAgo(10));
});

test('attaches tempo when the features map has it', () => {
    const features = new Map([['t1', { tempo: 128.4 }]]);
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])], [], NOW, features
    );

    expect(result[0].tempo).toBe(128.4);
});

test('tempo is null when the track has no features', () => {
    // ~32% of this library. Must be null, never 0 or undefined-by-omission,
    // so the UI can distinguish "no data" from "a real value".
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])], [], NOW, new Map()
    );

    expect(result[0].tempo).toBeNull();
});

test('works without a features map at all', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])], [], NOW
    );

    expect(result[0].tempo).toBeNull();
});

test('is idempotent — calling twice yields identical results', () => {
    const library = [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))], '[LIBRARY] One')];
    const classes = [classPlaylist('2026-07-25 Ride', [track('t1', 'Alpha', daysAgo(2))])];

    const first = buildTrackLibrary(library, classes, NOW);
    const second = buildTrackLibrary(library, classes, NOW);

    expect(second).toEqual(first);
    expect(second[0].lists).toBe('[LIBRARY] One');
    expect(second[0].recencyScore).toBe(10);
});
