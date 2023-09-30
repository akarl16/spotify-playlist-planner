import * as idb from 'idb';

let db;

async function init() {
    db = await idb.openDB('playlist-planner', 1, {
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
        const playlistTable = upgradeDb.createObjectStore('playlists', {keyPath: 'id'});
    }
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
        store.put(playlist, playlist.id);
    }
}

async function clearPlaylists() {
    let tx = db.transaction('playlists', 'readwrite');
    let store = tx.objectStore('playlists');
    store.clear();
}

export { init, db, getPlaylists, setPlaylists, clearPlaylists }