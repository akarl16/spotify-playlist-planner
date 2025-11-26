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
    return await db.getAll('playlists');
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

/**
 * Get statistics about the stored data
 * @returns {Promise<Object>} Statistics about playlists, tracks, and artists
 */
async function getStorageStats() {
    const stats = {
        playlists: {
            count: 0,
            totalTracks: 0,
            libraryPlaylists: 0,
            classPlaylists: 0
        },
        audioFeatures: {
            count: 0,
            withTempo: 0,
            withEnergy: 0,
            withDanceability: 0,
            spotifySource: 0,
            getsongbpmSource: 0,
            tempoDistribution: {
                slow: 0,      // < 100 BPM
                medium: 0,    // 100-130 BPM
                fast: 0,      // 130-160 BPM
                veryFast: 0   // > 160 BPM
            },
            avgTempo: 0,
            minTempo: null,
            maxTempo: null
        },
        artists: {
            count: 0
        },
        storageSize: {
            estimated: null
        }
    };

    try {
        // Get playlists stats
        const playlists = await db.getAll('playlists');
        stats.playlists.count = playlists.length;
        
        const dateRegex = /([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/;
        const libraryRegex = /\[LIBRARY\]/;
        
        for (const playlist of playlists) {
            if (playlist.trackList) {
                stats.playlists.totalTracks += playlist.trackList.length;
            }
            if (libraryRegex.test(playlist.name) || libraryRegex.test(playlist.description || '')) {
                stats.playlists.libraryPlaylists++;
            }
            if (dateRegex.test(playlist.name)) {
                stats.playlists.classPlaylists++;
            }
        }

        // Get audio features stats
        const audioFeatures = await db.getAll('tracksAudioFeatures');
        stats.audioFeatures.count = audioFeatures.length;
        
        let tempoSum = 0;
        let tempoCount = 0;
        
        for (const feature of audioFeatures) {
            if (feature.tempo !== null && feature.tempo !== undefined) {
                stats.audioFeatures.withTempo++;
                const tempo = parseFloat(feature.tempo);
                if (!isNaN(tempo)) {
                    tempoSum += tempo;
                    tempoCount++;
                    
                    if (stats.audioFeatures.minTempo === null || tempo < stats.audioFeatures.minTempo) {
                        stats.audioFeatures.minTempo = tempo;
                    }
                    if (stats.audioFeatures.maxTempo === null || tempo > stats.audioFeatures.maxTempo) {
                        stats.audioFeatures.maxTempo = tempo;
                    }
                    
                    // Categorize tempo
                    if (tempo < 100) {
                        stats.audioFeatures.tempoDistribution.slow++;
                    } else if (tempo < 130) {
                        stats.audioFeatures.tempoDistribution.medium++;
                    } else if (tempo < 160) {
                        stats.audioFeatures.tempoDistribution.fast++;
                    } else {
                        stats.audioFeatures.tempoDistribution.veryFast++;
                    }
                }
            }
            if (feature.energy !== null && feature.energy !== undefined) {
                stats.audioFeatures.withEnergy++;
            }
            if (feature.danceability !== null && feature.danceability !== undefined) {
                stats.audioFeatures.withDanceability++;
            }
            if (feature.source === 'spotify') {
                stats.audioFeatures.spotifySource++;
            } else if (feature.source === 'getsongbpm') {
                stats.audioFeatures.getsongbpmSource++;
            }
        }
        
        if (tempoCount > 0) {
            stats.audioFeatures.avgTempo = Math.round(tempoSum / tempoCount);
        }

        // Get artists stats
        const artists = await db.getAll('artists');
        stats.artists.count = artists.length;

        // Estimate storage size
        if (navigator.storage && navigator.storage.estimate) {
            const estimate = await navigator.storage.estimate();
            stats.storageSize.estimated = estimate.usage;
            stats.storageSize.quota = estimate.quota;
        }

    } catch (error) {
        console.error('Error getting storage stats:', error);
    }

    return stats;
}

/**
 * Get all unique tracks from playlists that don't have audio features (BPM) stored
 * @returns {Promise<Array>} Array of track objects needing BPM analysis
 */
async function getTracksNeedingBpmAnalysis() {
    const tracksNeedingAnalysis = [];
    const seenTrackIds = new Set();
    
    try {
        const playlists = await db.getAll('playlists');
        
        for (const playlist of playlists) {
            if (playlist.trackList) {
                for (const item of playlist.trackList) {
                    const track = item.track;
                    if (track && track.id && !seenTrackIds.has(track.id)) {
                        seenTrackIds.add(track.id);
                        
                        // Check if we already have audio features for this track
                        const existingFeatures = await getTrackAudioFeatures(track.id);
                        // Skip if we have features with tempo OR if we already checked and found nothing
                        const alreadyChecked = existingFeatures && (
                            existingFeatures.tempo || 
                            existingFeatures.source === 'getsongbpm-notfound'
                        );
                        if (!alreadyChecked) {
                            tracksNeedingAnalysis.push({
                                id: track.id,
                                name: track.name,
                                artists: track.artists?.map(a => a.name) || []
                            });
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error getting tracks needing BPM analysis:', error);
    }
    
    return tracksNeedingAnalysis;
}

/**
 * Clear all stored data
 */
async function clearAllData() {
    try {
        let tx = db.transaction(['playlists', 'tracksAudioFeatures', 'artists'], 'readwrite');
        await tx.objectStore('playlists').clear();
        await tx.objectStore('tracksAudioFeatures').clear();
        await tx.objectStore('artists').clear();
        await tx.done;
        console.log('All data cleared');
    } catch (error) {
        console.error('Error clearing data:', error);
        throw error;
    }
}

export { init, getPlaylist, getPlaylists, setPlaylist, setPlaylists, clearPlaylists, getTrackAudioFeatures, getTracksAudioFeatures, putTrackAudioFeatures, getArtist, putArtist, getStorageStats, clearAllData, getTracksNeedingBpmAnalysis }