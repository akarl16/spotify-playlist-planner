/**
 * ReccoBeats client — the replacement for Spotify's withdrawn /audio-features.
 *
 * Chosen because it keys off Spotify track IDs directly (no title/artist fuzzy
 * matching), needs no API key, is CORS-callable from the browser, and batches 40
 * ids per request. Measured coverage of this library is ~68%; the gap is expected
 * and is surfaced in the UI rather than hidden.
 */

const RECCOBEATS_API_BASE = 'https://api.reccobeats.com/v1';

// Hard limit: 41 ids returns HTTP 400.
const RECCOBEATS_BATCH_SIZE = 40;

class ReccoBeatsApiError extends Error {
    constructor(message, { status, kind }) {
        super(message);
        this.name = 'ReccoBeatsApiError';
        this.status = status;
        this.kind = kind;
    }
}

function classifyStatus(status) {
    if (status === 429) return 'rate_limit';
    return 'http';
}

// Responses omit ids the catalogue does not have, so position is meaningless.
// `href` is the only reliable link back to the Spotify id we asked about.
function spotifyIdFromHref(href) {
    const match = /track\/([^/?#]+)/.exec(href || '');
    return match ? match[1] : null;
}

async function reccoBeatsFetch(path, { onApiCall = null } = {}) {
    let response;
    try {
        response = await fetch(`${RECCOBEATS_API_BASE}${path}`, {
            headers: { Accept: 'application/json' }
        });
    } catch (err) {
        if (onApiCall) onApiCall({ path, status: 0, rateLimited: false });
        throw new ReccoBeatsApiError(err.message, { status: 0, kind: 'network' });
    }

    if (onApiCall) {
        onApiCall({ path, status: response.status, rateLimited: response.status === 429 });
    }

    if (!response.ok) {
        throw new ReccoBeatsApiError(
            `ReccoBeats API error: ${response.status} ${response.statusText}`,
            { status: response.status, kind: classifyStatus(response.status) }
        );
    }

    try {
        return await response.json();
    } catch (err) {
        throw new ReccoBeatsApiError(`Malformed JSON: ${err.message}`, {
            status: response.status, kind: 'http'
        });
    }
}

function assertSingleBatch(ids) {
    if (ids.length > RECCOBEATS_BATCH_SIZE) {
        throw new Error(
            `ReccoBeats accepts at most ${RECCOBEATS_BATCH_SIZE} ids per batch, got ${ids.length}`
        );
    }
}

/** Spotify track ids -> ReccoBeats ids. Ids not in the catalogue are simply absent. */
async function resolveTrackIds(spotifyIds, { onApiCall = null } = {}) {
    assertSingleBatch(spotifyIds);
    if (spotifyIds.length === 0) return new Map();

    const data = await reccoBeatsFetch(`/track?ids=${spotifyIds.join(',')}`, { onApiCall });

    const map = new Map();
    for (const entry of data.content ?? []) {
        const spotifyId = spotifyIdFromHref(entry.href);
        if (spotifyId && entry.id) map.set(spotifyId, entry.id);
    }
    return map;
}

/** ReccoBeats ids -> audio features, keyed by SPOTIFY id for storage. */
async function fetchAudioFeatures(reccoBeatsIds, { onApiCall = null } = {}) {
    assertSingleBatch(reccoBeatsIds);
    if (reccoBeatsIds.length === 0) return new Map();

    const data = await reccoBeatsFetch(`/audio-features?ids=${reccoBeatsIds.join(',')}`, { onApiCall });

    const map = new Map();
    for (const entry of data.content ?? []) {
        const spotifyId = spotifyIdFromHref(entry.href);
        if (!spotifyId) continue;
        map.set(spotifyId, {
            tempo: entry.tempo,
            energy: entry.energy,
            danceability: entry.danceability,
            key: entry.key,
            mode: entry.mode,
            valence: entry.valence,
            acousticness: entry.acousticness,
            instrumentalness: entry.instrumentalness,
            liveness: entry.liveness,
            loudness: entry.loudness,
            speechiness: entry.speechiness
        });
    }
    return map;
}

export {
    resolveTrackIds, fetchAudioFeatures,
    ReccoBeatsApiError, RECCOBEATS_BATCH_SIZE
};
