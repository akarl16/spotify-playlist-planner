import { SpotifyApiError, spotifyFetch, __setAccessTokenForTests, computeBackoffMs, RETRY_MAX_ATTEMPTS, RETRY_MAX_SLEEP_MS } from './spotify.js';

beforeEach(() => {
    localStorage.clear();
    __setAccessTokenForTests(undefined);
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

    await expect(spotifyFetch('/me/playlists', { sleep: jest.fn() })).rejects.toMatchObject({
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

    await expect(spotifyFetch('/me/playlists', { sleep: jest.fn() })).rejects.toMatchObject({ status: 500, kind: 'http' });
});

test('classifies a thrown fetch as network with status 0', async () => {
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(spotifyFetch('/me/playlists', { sleep: jest.fn() })).rejects.toMatchObject({ status: 0, kind: 'network' });
});

// Retry now lives inside spotifyFetch itself (see the retry-loop tests below), so a
// persistent 429 no longer produces exactly one request — it exhausts the attempt cap.
test('a persistent 429 exhausts the retry cap rather than retrying forever', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'Retry-After': '1' } }));

    await expect(spotifyFetch('/me/playlists', { sleep })).rejects.toThrow(SpotifyApiError);
    expect(global.fetch).toHaveBeenCalledTimes(RETRY_MAX_ATTEMPTS);
});

test('reports every attempt through onApiCall, including failures, until the cap is hit', async () => {
    const calls = [];
    const sleep = jest.fn().mockResolvedValue(undefined);
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'Retry-After': '3' } }));

    await expect(spotifyFetch('/me/playlists', { onApiCall: (info) => calls.push(info), sleep })).rejects.toThrow();

    expect(calls).toHaveLength(RETRY_MAX_ATTEMPTS);
    expect(calls.every(c => c.status === 429 && c.rateLimited)).toBe(true);
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

test('backoff honours Retry-After when present, in milliseconds', () => {
    expect(computeBackoffMs(1, 7, () => 0)).toBe(7000);
});

test('backoff grows exponentially when Retry-After is absent', () => {
    const noJitter = () => 0;
    expect(computeBackoffMs(1, null, noJitter)).toBe(1000);
    expect(computeBackoffMs(2, null, noJitter)).toBe(2000);
    expect(computeBackoffMs(3, null, noJitter)).toBe(4000);
});

test('backoff adds jitter so retries do not resynchronise into a fresh burst', () => {
    const full = computeBackoffMs(1, null, () => 1);
    const none = computeBackoffMs(1, null, () => 0);

    expect(full).toBeGreaterThan(none);
    expect(full).toBeLessThanOrEqual(none * 1.5);
});

test('a huge Retry-After is clamped rather than stalling a pool slot for hours', () => {
    // Spotify returns values like this when a rolling quota is exhausted.
    expect(computeBackoffMs(1, 3600, () => 0)).toBe(RETRY_MAX_SLEEP_MS);
});

test('exponential backoff is clamped at high attempt numbers', () => {
    expect(computeBackoffMs(10, null, () => 1)).toBe(RETRY_MAX_SLEEP_MS);
});

test('a Retry-After below the ceiling is still honoured exactly', () => {
    expect(computeBackoffMs(1, 7, () => 0)).toBe(7000);
});

test('retries a 429 and succeeds on a later attempt', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    global.fetch
        .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'Retry-After': '1' } }))
        .mockResolvedValueOnce(jsonResponse({ items: ['ok'] }));

    const result = await spotifyFetch('/me/playlists', { sleep });

    expect(result).toEqual({ items: ['ok'] });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
});

test('gives up after the attempt cap and throws the last error', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'Retry-After': '1' } }));

    await expect(spotifyFetch('/me/playlists', { sleep })).rejects.toMatchObject({ status: 429, kind: 'rate_limit' });
    expect(global.fetch).toHaveBeenCalledTimes(RETRY_MAX_ATTEMPTS);
});

test('retries 5xx and network failures', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    global.fetch
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(spotifyFetch('/me/playlists', { sleep })).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(3);
});

test('does NOT retry a 404 — retrying cannot help', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    global.fetch.mockResolvedValue(jsonResponse({}, { status: 404 }));

    await expect(spotifyFetch('/me/playlists', { sleep })).rejects.toMatchObject({ status: 404 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
});

test('reports every attempt through onApiCall so the 429 count stays truthful', async () => {
    const calls = [];
    const sleep = jest.fn().mockResolvedValue(undefined);
    global.fetch
        .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'Retry-After': '1' } }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await spotifyFetch('/me/playlists', { onApiCall: (info) => calls.push(info), sleep });

    expect(calls).toHaveLength(2);
    expect(calls.filter(c => c.rateLimited)).toHaveLength(1);
});

test('a non-JSON 200 body throws a SpotifyApiError, not a raw SyntaxError', async () => {
    global.fetch.mockResolvedValue({
        ok: true, status: 200, statusText: 'OK',
        headers: { get: () => null },
        json: async () => { throw new SyntaxError('Unexpected token <'); }
    });

    await expect(spotifyFetch('/me/playlists', { sleep: jest.fn() }))
        .rejects.toMatchObject({ name: 'SpotifyApiError', kind: 'http' });
});
