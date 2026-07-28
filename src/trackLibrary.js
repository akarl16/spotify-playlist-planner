const CLASS_DATE_REGEX = /([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/;

const RECENCY_TIERS = [
    { days: 7, points: 10 },
    { days: 30, points: 5 },
    { days: 90, points: 2 },
    { days: 180, points: 1 }
];

function scoreRecency(playedAtMs, now) {
    for (const tier of RECENCY_TIERS) {
        if (playedAtMs > now - tier.days * 24 * 60 * 60 * 1000) {
            return tier.points;
        }
    }
    return 0;
}

/**
 * Builds the flat track list the table renders.
 *
 * Pure: every returned row is a fresh object. The stored playlist records passed
 * in are never written to — the original decorated them in place, so a second call
 * within one session accumulated duplicate list names and overwrote added_at.
 *
 * @param {Array}  libraryPlaylists stored playlists carrying trackList
 * @param {Array}  classPlaylists   stored playlists carrying trackList
 * @param {number} now              millisecond timestamp, injected for testability
 */
function buildTrackLibrary(libraryPlaylists, classPlaylists, now) {
    const trackMap = new Map();

    for (const playlist of libraryPlaylists) {
        for (const storedTrack of playlist.trackList ?? []) {
            if (!storedTrack?.id) continue;

            const existing = trackMap.get(storedTrack.id);
            if (existing) {
                existing.lists += ',' + playlist.name;
                continue;
            }

            trackMap.set(storedTrack.id, {
                id: storedTrack.id,
                name: storedTrack.name,
                artists: storedTrack.artists,
                duration_ms: storedTrack.duration_ms,
                added_at: storedTrack.added_at,
                lists: playlist.name,
                plays: [],
                recencyScore: 0
            });
        }
    }

    for (const playlist of classPlaylists) {
        const dateMatch = CLASS_DATE_REGEX.exec(playlist.name);
        const playlistDateMs = dateMatch ? new Date(dateMatch[1]).getTime() : null;

        for (const storedTrack of playlist.trackList ?? []) {
            const track = trackMap.get(storedTrack?.id);
            if (!track) continue;

            const playedAtMs = playlistDateMs ?? new Date(storedTrack.added_at).getTime();
            const points = scoreRecency(playedAtMs, now);

            track.recencyScore += points;
            // A new object every time — the class date is the real play date, but
            // writing it back onto the stored track was the original bug.
            track.plays.push({
                playlistId: playlist.id,
                playlistName: playlist.name,
                added_at: new Date(playedAtMs),
                recencyScore: points
            });
        }
    }

    return Array.from(trackMap.values()).sort(
        (a, b) => a.recencyScore - b.recencyScore || b.added_at - a.added_at
    );
}

export { buildTrackLibrary, CLASS_DATE_REGEX };
