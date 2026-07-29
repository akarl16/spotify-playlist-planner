import {
    resolveTrackIds, fetchAudioFeatures, ReccoBeatsApiError, RECCOBEATS_BATCH_SIZE
} from './reccobeats.js';

beforeEach(() => {
    global.fetch = jest.fn();
});

function jsonResponse(body, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'x',
        headers: { get: () => null },
        json: async () => body
    };
}

const trackEntry = (rbId, spotifyId) => ({
    id: rbId, href: `https://open.spotify.com/track/${spotifyId}`, trackTitle: 'T'
});

test('resolveTrackIds maps spotify ids to reccobeats ids', async () => {
    global.fetch.mockResolvedValue(jsonResponse({
        content: [trackEntry('rb-1', 'sp-1'), trackEntry('rb-2', 'sp-2')]
    }));

    const map = await resolveTrackIds(['sp-1', 'sp-2']);

    expect(map.get('sp-1')).toBe('rb-1');
    expect(map.get('sp-2')).toBe('rb-2');
});

test('resolveTrackIds maps by href, not by response order', async () => {
    // Responses omit misses, so index alignment would silently mis-assign.
    global.fetch.mockResolvedValue(jsonResponse({
        content: [trackEntry('rb-3', 'sp-3'), trackEntry('rb-1', 'sp-1')]
    }));

    const map = await resolveTrackIds(['sp-1', 'sp-2', 'sp-3']);

    expect(map.get('sp-1')).toBe('rb-1');
    expect(map.get('sp-3')).toBe('rb-3');
    expect(map.has('sp-2')).toBe(false);
});

test('resolveTrackIds omits ids the catalogue does not have', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ content: [trackEntry('rb-1', 'sp-1')] }));

    const map = await resolveTrackIds(['sp-1', 'sp-missing']);

    expect(map.size).toBe(1);
    expect(map.has('sp-missing')).toBe(false);
});

test('resolveTrackIds tolerates an empty content array', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ content: [] }));

    await expect(resolveTrackIds(['sp-1'])).resolves.toEqual(new Map());
});

test('resolveTrackIds returns an empty map without calling fetch for no ids', async () => {
    await expect(resolveTrackIds([])).resolves.toEqual(new Map());
    expect(global.fetch).not.toHaveBeenCalled();
});

test('resolveTrackIds refuses more than one batch', async () => {
    const tooMany = Array.from({ length: RECCOBEATS_BATCH_SIZE + 1 }, (_, i) => `sp-${i}`);

    await expect(resolveTrackIds(tooMany)).rejects.toThrow(/batch/i);
    expect(global.fetch).not.toHaveBeenCalled();
});

test('fetchAudioFeatures keys results by spotify id and keeps the numeric fields', async () => {
    global.fetch.mockResolvedValue(jsonResponse({
        content: [{
            id: 'rb-1', href: 'https://open.spotify.com/track/sp-1',
            tempo: 171.001, energy: 0.73, danceability: 0.513, key: 1, mode: 1,
            valence: 0.334, acousticness: 0.00143, instrumentalness: 9.54e-05,
            liveness: 0.0897, loudness: -5.94, speechiness: 0.0598
        }]
    }));

    const map = await fetchAudioFeatures(['rb-1']);

    expect(map.get('sp-1')).toMatchObject({ tempo: 171.001, energy: 0.73, key: 1 });
});

test('a 429 throws a typed rate_limit error', async () => {
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 429 }));

    await expect(resolveTrackIds(['sp-1'])).rejects.toMatchObject({
        name: 'ReccoBeatsApiError', status: 429, kind: 'rate_limit'
    });
});

test('a transport failure throws a typed network error', async () => {
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(resolveTrackIds(['sp-1'])).rejects.toMatchObject({ status: 0, kind: 'network' });
});

test('reports each request through onApiCall', async () => {
    const calls = [];
    global.fetch.mockResolvedValue(jsonResponse({ content: [] }));

    await resolveTrackIds(['sp-1'], { onApiCall: (info) => calls.push(info) });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 200, rateLimited: false });
});
