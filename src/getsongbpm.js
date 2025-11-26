/**
 * GetSongBPM API Service
 * https://getsongbpm.com/api
 */

const API_BASE = 'https://api.getsongbpm.com';
const API_KEY = process.env.REACT_APP_GETSONGBPM_API_KEY;

/**
 * Search for a song by title and artist
 * @param {string} title - Song title
 * @param {string} artist - Artist name
 * @returns {Promise<object|null>} - Song data with tempo or null if not found
 */
async function searchSong(title, artist) {
  if (!API_KEY) {
    console.warn('GetSongBPM API key not configured');
    return null;
  }

  try {
    // Clean up search terms
    const cleanTitle = cleanSearchTerm(title);
    const cleanArtist = cleanSearchTerm(artist);
    
    const searchQuery = encodeURIComponent(`${cleanTitle} ${cleanArtist}`);
    const url = `${API_BASE}/search/?api_key=${API_KEY}&type=song&lookup=${searchQuery}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      if (response.status === 429) {
        console.warn('GetSongBPM rate limit exceeded');
      }
      return null;
    }
    
    const data = await response.json();
    
    if (data.search && data.search.length > 0) {
      // Find best match
      const match = findBestMatch(data.search, cleanTitle, cleanArtist);
      if (match) {
        // Get full song details for tempo
        return await getSongDetails(match.id);
      }
    }
    
    return null;
  } catch (error) {
    console.error('GetSongBPM search error:', error);
    return null;
  }
}

/**
 * Get detailed song information including tempo
 * @param {string} songId - GetSongBPM song ID
 * @returns {Promise<object|null>} - Song details with tempo
 */
async function getSongDetails(songId) {
  if (!API_KEY) {
    return null;
  }

  try {
    const url = `${API_BASE}/song/?api_key=${API_KEY}&id=${songId}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    
    if (data.song) {
      return {
        tempo: data.song.tempo ? parseFloat(data.song.tempo) : null,
        key: data.song.key_of || null,
        energy: data.song.energy || null,
        danceability: data.song.danceability || null,
        source: 'getsongbpm'
      };
    }
    
    return null;
  } catch (error) {
    console.error('GetSongBPM song details error:', error);
    return null;
  }
}

/**
 * Clean search term by removing common suffixes and special characters
 */
function cleanSearchTerm(term) {
  if (!term) return '';
  
  return term
    .replace(/\s*\(.*?\)\s*/g, ' ')  // Remove parenthetical content
    .replace(/\s*\[.*?\]\s*/g, ' ')  // Remove bracketed content
    .replace(/\s*-\s*(remaster|remix|edit|version|mix|radio|extended|live|acoustic|instrumental|explicit|clean).*$/i, '')
    .replace(/\s*feat\.?\s*.*/i, '') // Remove featuring artists
    .replace(/\s*ft\.?\s*.*/i, '')
    .trim();
}

/**
 * Find best matching song from search results
 */
function findBestMatch(results, title, artist) {
  const normalizedTitle = title.toLowerCase();
  const normalizedArtist = artist.toLowerCase();
  
  // First try exact matches
  for (const result of results) {
    const resultTitle = (result.title || '').toLowerCase();
    const resultArtist = (result.artist?.name || '').toLowerCase();
    
    if (resultTitle === normalizedTitle && resultArtist.includes(normalizedArtist)) {
      return result;
    }
  }
  
  // Then try partial matches
  for (const result of results) {
    const resultTitle = (result.title || '').toLowerCase();
    const resultArtist = (result.artist?.name || '').toLowerCase();
    
    if (resultTitle.includes(normalizedTitle) || normalizedTitle.includes(resultTitle)) {
      if (resultArtist.includes(normalizedArtist) || normalizedArtist.includes(resultArtist)) {
        return result;
      }
    }
  }
  
  // Return first result as fallback
  return results[0] || null;
}

/**
 * Get audio features for multiple tracks
 * @param {Array} tracks - Array of track objects with name and artists
 * @param {Function} onProgress - Progress callback (current, total)
 * @returns {Promise<Map>} - Map of trackId to audio features
 */
async function getAudioFeaturesForTracks(tracks, onProgress = null) {
  const results = new Map();
  
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const artistName = track.artists && track.artists[0] ? track.artists[0].name : '';
    
    const features = await searchSong(track.name, artistName);
    
    if (features) {
      results.set(track.id, {
        id: track.id,
        tempo: features.tempo,
        energy: features.energy,
        danceability: features.danceability,
        key: features.key,
        source: 'getsongbpm'
      });
    }
    
    if (onProgress) {
      onProgress(i + 1, tracks.length);
    }
    
    // Rate limiting - GetSongBPM has limits, so add a small delay
    if (i < tracks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  return results;
}

export { searchSong, getSongDetails, getAudioFeaturesForTracks };
