/**
 * GetSongBPM API Service
 * https://getsongbpm.com/api
 * 
 * Makes direct browser calls to the GetSongBPM API.
 * 
 * IMPORTANT: Use api.getsong.co (not api.getsongbpm.com)
 * - api.getsongbpm.com has Cloudflare Turnstile challenge that blocks requests
 * - api.getsong.co is the redirect target with CORS enabled (access-control-allow-origin: *)
 */

// Use api.getsong.co directly to bypass Cloudflare challenge on api.getsongbpm.com
const API_BASE = 'https://api.getsong.co';
  
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
    
    // IMPORTANT: Search by title only - the API doesn't work well with combined "title artist" searches
    // We'll filter results by artist after getting them
    const searchQuery = encodeURIComponent(cleanTitle);
    const url = `${API_BASE}/search/?api_key=${API_KEY}&type=song&lookup=${searchQuery}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      if (response.status === 429) {
        console.warn('GetSongBPM rate limit exceeded');
      }
      return null;
    }
    
    const data = await response.json();
    
    // API returns { search: [...] } on success, { search: { error: "no result" } } on no results
    if (data.search && Array.isArray(data.search) && data.search.length > 0) {
      // Find best match by artist
      const match = findBestMatch(data.search, cleanTitle, cleanArtist);
      if (match) {
        // Search results already include tempo, key, danceability, acousticness
        // So we can return directly without a second API call
        return {
          tempo: match.tempo ? parseFloat(match.tempo) : null,
          key: match.key_of || null,
          timeSignature: match.time_sig || null,
          danceability: match.danceability || null,
          acousticness: match.acousticness || null,
          artist: match.artist?.name || null,
          album: match.album?.title || null,
          source: 'getsongbpm'
        };
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
 * Priority: exact artist match > partial artist match > null (no fallback to wrong artist)
 */
function findBestMatch(results, title, artist) {
  const normalizedTitle = title.toLowerCase().trim();
  const normalizedArtist = artist.toLowerCase().trim();
  
  // Split artist name for multi-word matching (e.g., "Michael Jackson" -> ["michael", "jackson"])
  const artistWords = normalizedArtist.split(/\s+/).filter(w => w.length > 2);
  
  // Score each result
  const scored = results.map(result => {
    const resultTitle = (result.title || '').toLowerCase().trim();
    const resultArtist = (result.artist?.name || '').toLowerCase().trim();
    
    let titleScore = 0;
    let artistScore = 0;
    
    // Title matching (required for a good match)
    if (resultTitle === normalizedTitle) {
      titleScore = 100; // Exact title match
    } else if (resultTitle.includes(normalizedTitle) || normalizedTitle.includes(resultTitle)) {
      titleScore = 50; // Partial title match
    }
    
    // Skip if no title match
    if (titleScore === 0) {
      return { result, score: 0, hasArtistMatch: false };
    }
    
    // Artist matching
    if (resultArtist === normalizedArtist) {
      artistScore = 100; // Exact artist match
    } else if (resultArtist.includes(normalizedArtist) || normalizedArtist.includes(resultArtist)) {
      artistScore = 75; // Partial artist match
    } else {
      // Check if any significant words from artist match
      const artistWordMatches = artistWords.filter(word => resultArtist.includes(word));
      if (artistWordMatches.length > 0) {
        artistScore = 25 * artistWordMatches.length; // Partial word match
      }
    }
    
    return { 
      result, 
      score: titleScore + artistScore, 
      hasArtistMatch: artistScore > 0 
    };
  });
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  // Only return if we have both a title match AND artist match
  // This prevents returning a cover version when the original artist isn't in the database
  if (scored.length > 0 && scored[0].hasArtistMatch) {
    return scored[0].result;
  }
  
  // Return null rather than wrong artist - database doesn't have this song/artist combo
  return null;
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
