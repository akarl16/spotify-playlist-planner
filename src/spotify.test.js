import { SpotifyApiError, spotifyFetch, isAuthorized, onSessionExpired, __setAccessTokenForTests, computeBackoffMs, RETRY_MAX_ATTEMPTS, RETRY_MAX_SLEEP_MS } from './spotify.js';

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

// --- Token refresh -----------------------------------------------------------

const TOKEN_URL = 'https://accounts.spotify.com/api/token';

// Routes token-endpoint calls to `token` and API calls to `api`, each a queue of
// responses (the last one repeats).
function routeFetch({ api = [], token = [] }) {
    const take = (queue) => (queue.length > 1 ? queue.shift() : queue[0]);
    global.fetch.mockImplementation(async (url) => (url === TOKEN_URL ? take(token) : take(api)));
}

const apiCalls = () => global.fetch.mock.calls.filter(([url]) => url !== TOKEN_URL);
const tokenCalls = () => global.fetch.mock.calls.filter(([url]) => url === TOKEN_URL);

test('a 401 refreshes the token once and retries the request with the new token', async () => {
    localStorage.setItem('refresh_token', 'rt-old');
    routeFetch({
        api: [jsonResponse({}, { status: 401 }), jsonResponse({ items: ['ok'] })],
        token: [jsonResponse({ access_token: 'fresh', expires_in: 3600 })]
    });

    await expect(spotifyFetch('/me/playlists')).resolves.toEqual({ items: ['ok'] });

    expect(tokenCalls()).toHaveLength(1);
    expect(apiCalls()[1][1].headers.Authorization).toBe('Bearer fresh');
});

test('a refresh response without refresh_token keeps the stored one instead of writing "undefined"', async () => {
    // Spotify usually omits refresh_token from refresh responses.
    localStorage.setItem('refresh_token', 'rt-old');
    routeFetch({
        api: [jsonResponse({}, { status: 401 }), jsonResponse({})],
        token: [jsonResponse({ access_token: 'fresh', expires_in: 3600 })]
    });

    await spotifyFetch('/me/playlists');

    expect(localStorage.getItem('refresh_token')).toBe('rt-old');
});

test('a refresh response with a rotated refresh_token stores the new one', async () => {
    localStorage.setItem('refresh_token', 'rt-old');
    routeFetch({
        api: [jsonResponse({}, { status: 401 }), jsonResponse({})],
        token: [jsonResponse({ access_token: 'fresh', expires_in: 3600, refresh_token: 'rt-new' })]
    });

    await spotifyFetch('/me/playlists');

    expect(localStorage.getItem('refresh_token')).toBe('rt-new');
});

test.each(['undefined', 'null', ''])(
    'a stored refresh_token of %p is treated as missing: no refresh attempt, session expired',
    async (stored) => {
        localStorage.setItem('refresh_token', stored);
        const listener = jest.fn();
        const unsubscribe = onSessionExpired(listener);
        routeFetch({ api: [jsonResponse({}, { status: 401 })] });

        await expect(spotifyFetch('/me/playlists')).rejects.toMatchObject({ kind: 'auth', status: 401, sessionExpired: true });

        expect(tokenCalls()).toHaveLength(0);
        expect(localStorage.getItem('refresh_token')).toBeNull();
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    }
);

test('a rejected refresh (400 invalid_grant) reports the session as expired', async () => {
    localStorage.setItem('refresh_token', 'rt-revoked');
    const listener = jest.fn();
    const unsubscribe = onSessionExpired(listener);
    routeFetch({
        api: [jsonResponse({}, { status: 401 })],
        token: [jsonResponse({ error: 'invalid_grant' }, { status: 400 })]
    });

    await expect(spotifyFetch('/me/playlists')).rejects.toMatchObject({ sessionExpired: true });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(apiCalls()).toHaveLength(1);
    unsubscribe();
});

test('a transient refresh failure fails the request but keeps the session', async () => {
    localStorage.setItem('refresh_token', 'rt-old');
    const listener = jest.fn();
    const unsubscribe = onSessionExpired(listener);
    routeFetch({
        api: [jsonResponse({}, { status: 401 })],
        token: [jsonResponse({}, { status: 503 })]
    });

    const error = await spotifyFetch('/me/playlists').catch((err) => err);

    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect(error.sessionExpired).toBeFalsy();
    expect(listener).not.toHaveBeenCalled();
    expect(localStorage.getItem('refresh_token')).toBe('rt-old');
    unsubscribe();
});

test('a 401 after a successful refresh is thrown, not refreshed again', async () => {
    localStorage.setItem('refresh_token', 'rt-old');
    routeFetch({
        api: [jsonResponse({}, { status: 401 })],
        token: [jsonResponse({ access_token: 'fresh', expires_in: 3600 })]
    });

    await expect(spotifyFetch('/me/playlists')).rejects.toMatchObject({ status: 401 });

    expect(tokenCalls()).toHaveLength(1);
    expect(apiCalls()).toHaveLength(2);
});

test('concurrent 401s share a single token refresh', async () => {
    localStorage.setItem('refresh_token', 'rt-old');
    global.fetch.mockImplementation(async (url, init) => {
        if (url === TOKEN_URL) return jsonResponse({ access_token: 'fresh', expires_in: 3600 });
        return init.headers.Authorization === 'Bearer fresh'
            ? jsonResponse({ ok: true })
            : jsonResponse({}, { status: 401 });
    });

    await Promise.all([spotifyFetch('/a'), spotifyFetch('/b')]);

    expect(tokenCalls()).toHaveLength(1);
});

test('a 403 does not trigger a token refresh — it is a permission error, not expiry', async () => {
    localStorage.setItem('refresh_token', 'rt-old');
    routeFetch({ api: [jsonResponse({}, { status: 403 })] });

    await expect(spotifyFetch('/me/playlists')).rejects.toMatchObject({ status: 403, kind: 'auth' });

    expect(tokenCalls()).toHaveLength(0);
});

test('a token known to be expired is refreshed before the request is sent', async () => {
    __setAccessTokenForTests('stale', Date.now() - 1000);
    localStorage.setItem('refresh_token', 'rt-old');
    routeFetch({
        api: [jsonResponse({ ok: true })],
        token: [jsonResponse({ access_token: 'fresh', expires_in: 3600 })]
    });

    await spotifyFetch('/me/playlists');

    expect(tokenCalls()).toHaveLength(1);
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0][1].headers.Authorization).toBe('Bearer fresh');
});

test('isAuthorized treats a stored "undefined" refresh_token as missing', async () => {
    __setAccessTokenForTests(undefined);
    localStorage.setItem('refresh_token', 'undefined');

    await expect(isAuthorized()).resolves.toBe(false);

    expect(tokenCalls()).toHaveLength(0);
    expect(localStorage.getItem('refresh_token')).toBeNull();
});
