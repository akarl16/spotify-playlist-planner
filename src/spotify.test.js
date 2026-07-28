import { SpotifyApiError, spotifyFetch, __setAccessTokenForTests } from './spotify.js';

beforeEach(() => {
    __setAccessTokenForTests('fake-token');
    global.fetch = jest.fn();
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'x',
        headers: { get: (name) => headers[name] ?? null },
        json: async () => body
    };
}

test('returns parsed JSON on success', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ items: [1, 2] }));

    const result = await spotifyFetch('/me/playlists');

    expect(result).toEqual({ items: [1, 2] });
    expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('throws SpotifyApiError with kind rate_limit and parsed Retry-After on 429', async () => {
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'Retry-After': '7' } }));

    await expect(spotifyFetch('/me/playlists')).rejects.toMatchObject({
        name: 'SpotifyApiError',
        status: 429,
        kind: 'rate_limit',
        retryAfter: 7
    });
});

test('classifies 401 as auth', async () => {
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 401 }));

    await expect(spotifyFetch('/me/playlists')).rejects.toMatchObject({ status: 401, kind: 'auth' });
});

test('classifies 500 as http', async () => {
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 500 }));

    await expect(spotifyFetch('/me/playlists')).rejects.toMatchObject({ status: 500, kind: 'http' });
});

test('classifies a thrown fetch as network with status 0', async () => {
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(spotifyFetch('/me/playlists')).rejects.toMatchObject({ status: 0, kind: 'network' });
});

test('does NOT retry — one failure produces exactly one request', async () => {
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'Retry-After': '1' } }));

    await expect(spotifyFetch('/me/playlists')).rejects.toThrow(SpotifyApiError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('reports every request through onApiCall, including failures', async () => {
    const calls = [];
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'Retry-After': '3' } }));

    await expect(spotifyFetch('/me/playlists', { onApiCall: (info) => calls.push(info) })).rejects.toThrow();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 429, rateLimited: true });
});

test('returns null for 204 No Content', async () => {
    global.fetch.mockResolvedValue({
        ok: true,
        status: 204,
        statusText: 'No Content',
        headers: { get: () => null },
        json: async () => { throw new Error('should not be called'); }
    });

    await expect(spotifyFetch('/me/player/play', { method: 'PUT' })).resolves.toBeNull();
});
