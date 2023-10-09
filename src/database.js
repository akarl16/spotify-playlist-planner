import * as idb from 'idb';

let db;

async function init() {
    db = await idb.openDB('playlist-planner', 2, {
        upgrade
    });
    console.log('Successfully opened DB');
}

function upgrade(upgradeDb) {
    console.log('Upgrading or Creating DB');
    upgradeDb.onerror = () => {
        console.error('Error loading database.');
    };
    if (!upgradeDb.objectStoreNames.contains('playlists')) {
        upgradeDb.createObjectStore('playlists', { keyPath: 'id' });
    }
    if (!upgradeDb.objectStoreNames.contains('tracksAudioFeatures')) {
        upgradeDb.createObjectStore('tracksAudioFeatures', { keyPath: 'id' });
    }
    if (!upgradeDb.objectStoreNames.contains('artists')) {
        upgradeDb.createObjectStore('artists', { keyPath: 'id' });
    }
}

async function getPlaylist(playlistId) {
    return await db.get('playlists', playlistId);
}

async function getPlaylists() {
    let tx = db.transaction('playlists', 'readonly');
    let store = tx.objectStore('playlists');

    return await store.getAll();
}

async function setPlaylists(playlists) {
    let tx = db.transaction('playlists', 'readwrite');
    let store = tx.objectStore('playlists');

    for (const playlist of playlists) {
        await setPlaylistNoOverwrite(playlist, store);
    }
}

async function setPlaylist(playlist) {
    await db.put('playlists', playlist);
}

async function setPlaylistNoOverwrite(playlist, store) {
    const existingPlaylist = await store.get(playlist.id);
    if (!existingPlaylist) {
        console.debug(`new playlist ${playlist.id} added to store`);
        await store.put(playlist);
    } else if (existingPlaylist.snapshot_id !== playlist.snapshot_id) {
        console.debug(`updated playlist ${playlist.id} based on snapshot`);
        await store.put(playlist);
    } else {
        console.debug(`playlist ${playlist.id} already stored`);
    }
}

async function clearPlaylists() {
    let tx = db.transaction('playlists', 'readwrite');
    let store = tx.objectStore('playlists');
    await store.clear();
}

async function getTrackAudioFeatures(trackId) {
    return await db.get('tracksAudioFeatures', trackId);
}

async function getTracksAudioFeatures(trackIds) {
    const tracksAudioFeatures = new Map();
    
    for ( const trackId of trackIds ) {
        const track = await getTrackAudioFeatures(trackId);
        if(track) {
            tracksAudioFeatures.set(trackId, track);
        }
    }
    return tracksAudioFeatures;
}

async function putTrackAudioFeatures(track) {
    await db.put('tracksAudioFeatures', track);
}

async function getArtist(artistId) {
    return await db.get('artists', artistId);
}

async function putArtist(artist) {
    await db.put('artists', artist, artist.id);
}

export { init, getPlaylist, getPlaylists, setPlaylist, setPlaylists, clearPlaylists, getTrackAudioFeatures, getTracksAudioFeatures, putTrackAudioFeatures, getArtist, putArtist }