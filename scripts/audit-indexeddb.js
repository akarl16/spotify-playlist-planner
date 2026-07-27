// scripts/audit-indexeddb.js
//
// Paste into the devtools console on the running app. Read-only — opens the
// database at its current version and never triggers an upgrade.
(async () => {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('playlist-planner');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    const playlists = await new Promise((resolve, reject) => {
        const request = db.transaction('playlists').objectStore('playlists').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    const dateRegex = /([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/;
    const libraryRegex = /\[LIBRARY\]/;
    const uniqueTrackIds = new Set();
    let totalTrackEntries = 0;
    let missingTrackList = 0;
    const suspicious = [];

    for (const playlist of playlists) {
        if (!playlist.trackList) {
            missingTrackList++;
            continue;
        }
        totalTrackEntries += playlist.trackList.length;
        for (const track of playlist.trackList) {
            if (track?.id) uniqueTrackIds.add(track.id);
        }

        const expected = playlist.tracks?.total ?? null;
        const stored = playlist.trackList.length;
        // A multiple of 50 that falls short of the header total is the signature
        // of a pagination loop that broke mid-flight.
        if (expected !== null && stored < expected) {
            suspicious.push({
                name: playlist.name,
                stored,
                expected,
                shortfall: expected - stored,
                endsOnPageBoundary: stored > 0 && stored % 50 === 0
            });
        }
    }

    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {};

    console.log('=== PLAYLISTS ===');
    console.table({
        total: playlists.length,
        library: playlists.filter(p => libraryRegex.test(p.name) || libraryRegex.test(p.description || '')).length,
        class: playlists.filter(p => dateRegex.test(p.name)).length,
        missingTrackList
    });

    console.log('=== TRACKS ===');
    console.table({
        totalEntries: totalTrackEntries,
        unique: uniqueTrackIds.size,
        duplicationFactor: uniqueTrackIds.size
            ? (totalTrackEntries / uniqueTrackIds.size).toFixed(2)
            : 'n/a'
    });

    console.log('=== STORAGE ===');
    console.table({
        usedMB: estimate.usage ? (estimate.usage / 1024 / 1024).toFixed(1) : 'unknown',
        quotaMB: estimate.quota ? (estimate.quota / 1024 / 1024).toFixed(0) : 'unknown'
    });

    console.log(`=== SHORT OF tracks.total: ${suspicious.length} of ${playlists.length} ===`);
    console.log(`  ...of which end exactly on a 50-track page boundary: ${suspicious.filter(s => s.endsOnPageBoundary).length}`);
    console.table(suspicious.slice(0, 40));

    db.close();
    return { playlists: playlists.length, uniqueTracks: uniqueTrackIds.size, suspicious: suspicious.length };
})();
