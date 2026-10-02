import SpotifyWebApi from "spotify-web-api-js";

let scope = "playlist-read-collaborative playlist-read-private playlist-modify-public playlist-modify-private streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state";
let access_token;
// Epoch ms when access_token stops working, or null when unknown. Lets a call
// refresh ahead of time instead of spending a request on a guaranteed 401.
let accessTokenExpiresAt = null;

function setWithExpiry(key, value, ttl) {
	const now = new Date()

	// `item` is an object which contains the original value
	// as well as the time when it's supposed to expire
	const item = {
		value: value,
		expiry: now.getTime() + ttl,
	}
	localStorage.setItem(key, JSON.stringify(item))
}

function getWithExpiry(key) {
	const itemStr = localStorage.getItem(key)
	// if the item doesn't exist, return null
	if (!itemStr) {
		return null
	}
	const item = JSON.parse(itemStr)
	const now = new Date()
	// compare the expiry time of the item with the current time
	if (now.getTime() > item.expiry) {
		// If the item is expired, delete the item from storage
		// and return null
        console.debug("Expired key: " + key);
		localStorage.removeItem(key)
		return null
	}
	return item.value
}

// Spotify usually omits refresh_token from refresh responses. An unguarded write
// once stored the literal string "undefined", which then failed every refresh.
const MISSING_REFRESH_TOKEN_VALUES = new Set(['', 'undefined', 'null']);

// Returns the stored refresh token, or null. A corrupt value is discarded so the
// app falls through to the sign-in flow instead of retrying it forever.
function readRefreshToken() {
    const stored = localStorage.getItem('refresh_token');
    if (stored === null) return null;
    if (MISSING_REFRESH_TOKEN_VALUES.has(stored)) {
        localStorage.removeItem('refresh_token');
        return null;
    }
    return stored;
}

function storeTokens(data) {
    const ttl = data.expires_in * 1000;
    setWithExpiry('access_token', data.access_token, ttl);
    // Only overwrite when Spotify actually rotated it.
    if (data.refresh_token) {
        localStorage.setItem('refresh_token', data.refresh_token);
    }
    access_token = data.access_token;
    accessTokenExpiresAt = Date.now() + ttl;
    spotifyApi.setAccessToken(access_token);
}

function generateRandomString(length) {
    let text = '';
    let possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

async function generateCodeChallenge(codeVerifier) {
    function base64encode(string) {
        return btoa(String.fromCharCode.apply(null, new Uint8Array(string)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);

    return base64encode(digest);
}

// The redirect URI must be identical in the authorize call and the token
// exchange, and must exactly match (including trailing slash) a URI
// registered in the Spotify app settings. Registered URIs:
//   https://spotify-playlist-planner-liard.vercel.app/
//   https://akarl16.github.io/spotify-playlist-planner/
//   http://127.0.0.1:3000/spotify-playlist-planner
// The app has no client-side routes, so origin + pathname of the page the
// user is on matches the registered entry for each environment.
function getRedirectUrl() {
    return window.location.origin + window.location.pathname;
}

function getAuthorizationCodeFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    let code = urlParams.get('code');
    return code;
};

async function retrieveAccessTokenFromAuth(authorization_code) {
    console.debug("retrieveAccessTokenFromAuth");
    let codeVerifier = localStorage.getItem('code_verifier');
    let redirect_url = getRedirectUrl();

    let body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorization_code,
        redirect_uri: redirect_url,
        client_id: clientId,
        code_verifier: codeVerifier
    });

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body
    });

    if (!response.ok) {
        throw new Error('HTTP status ' + response.status);
    }
    const data = await response.json();

    storeTokens(data);
    localStorage.removeItem('authorization_code');
    localStorage.removeItem('code_verifier');

    return data.access_token;
}

// Returns a fresh access token, or null if the refresh could not complete.
// On null, the caller must fall through to the sign-in flow.
async function retrieveAccessTokenFromRefresh(refresh_token) {
    console.debug("retrieveAccessTokenFromRefresh");
    let body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
        client_id: clientId,
    });

    let response;
    try {
        response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: body
        });
    } catch (err) {
        // Network error — keep the token so a transient blip doesn't force re-login.
        console.error('Token refresh request failed (network):', err);
        return null;
    }

    if (!response.ok) {
        // Since July 20, 2026 Spotify refresh tokens expire after six months, and a
        // revoked/expired token returns 400 invalid_grant. Per Spotify guidance:
        // discard the stored token (do NOT retry it) and re-run the sign-in flow.
        let errorBody = {};
        try {
            errorBody = await response.json();
        } catch {
            // non-JSON error body; fall through to status check below
        }

        if (response.status === 400 || errorBody.error === 'invalid_grant') {
            console.warn('Refresh token expired or revoked — discarding stored token; re-authorization required.');
            localStorage.removeItem('refresh_token');
            localStorage.removeItem('access_token');
        } else {
            // Transient failure (e.g. 5xx / 429). Keep the token; just fail this attempt.
            console.error('Token refresh failed (transient):', response.status);
        }
        return null;
    }

    const data = await response.json();

    storeTokens(data);

    return data.access_token;
}

let refreshInFlight = null;

// Resolves to a fresh access token, or null. Concurrent callers share one request:
// the sync pool runs two workers, and both see the same expired token at once.
function refreshAccessToken() {
    if (!refreshInFlight) {
        refreshInFlight = (async () => {
            const refresh_token = readRefreshToken();
            if (!refresh_token) return null;
            return await retrieveAccessTokenFromRefresh(refresh_token);
        })().finally(() => {
            refreshInFlight = null;
        });
    }
    return refreshInFlight;
}

const sessionExpiredListeners = new Set();

// Called when the session cannot be renewed without the user signing in again.
// Returns an unsubscribe function.
function onSessionExpired(listener) {
    sessionExpiredListeners.add(listener);
    return () => sessionExpiredListeners.delete(listener);
}

function notifySessionExpired() {
    for (const listener of [...sessionExpiredListeners]) listener();
}

function authorizeSpotify() {
    let codeVerifier = generateRandomString(128);

    generateCodeChallenge(codeVerifier).then(codeChallenge => {
        let state = generateRandomString(16);
        localStorage.setItem('code_verifier', codeVerifier);
        let redirect_url = getRedirectUrl();

        let args = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            scope: scope,
            redirect_uri: redirect_url,
            state: state,
            code_challenge_method: 'S256',
            code_challenge: codeChallenge
        });

        window.location = 'https://accounts.spotify.com/authorize?' + args;
    });
}

async function isAuthorized() {
    let authorization_code = getAuthorizationCodeFromUrl();
    if (authorization_code) {
        console.debug("Authorization code found in URL");
        localStorage.setItem('authorization_code', authorization_code);
        // Strip the query without reloading: a reload here races the token
        // exchange below, and the reload's second exchange attempt fails
        // because the authorization code is single-use.
        window.history.replaceState({}, '', window.location.pathname);
    }
    authorization_code = localStorage.getItem('authorization_code');

    access_token = getWithExpiry("access_token");
    
    if (!access_token) {
        console.debug("No access_token found in local storage");
        let refresh_token = readRefreshToken();
        if(refresh_token) {
            access_token = await retrieveAccessTokenFromRefresh(refresh_token);
            if (access_token) {
                spotifyApi.setAccessToken(access_token);
                return true;
            }
            // Refresh failed (e.g. token expired/revoked and was discarded).
            // Fall through to the authorization-code flow or the Connect button.
            console.debug("Refresh failed; re-authorization required");
        }
        if(authorization_code) {
            access_token = await retrieveAccessTokenFromAuth(authorization_code);
            spotifyApi.setAccessToken(access_token);
            return true;
        }
    } else {
        console.debug("Token found in storage");
        accessTokenExpiresAt = JSON.parse(localStorage.getItem("access_token")).expiry;
        spotifyApi.setAccessToken(access_token);
        return true;
    }
    return false;
}

async function getSpotifyApi() {
    await isAuthorized();
    return spotifyApi;
}

function getAccessToken() {
    return access_token;
}

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

class SpotifyApiError extends Error {
    constructor(message, { status, retryAfter = null, kind }) {
        super(message);
        this.name = 'SpotifyApiError';
        this.status = status;
        this.retryAfter = retryAfter;
        this.kind = kind;
    }
}

function classifyStatus(status) {
    if (status === 429) return 'rate_limit';
    if (status === 401 || status === 403) return 'auth';
    return 'http';
}

// Spotify sends Retry-After in whole seconds. Anything unparseable is treated as
// absent so callers fall back to their own backoff rather than waiting on NaN.
function parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const seconds = Number(headerValue);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const RETRY_JITTER_FRACTION = 0.5;

// Spotify can return very large Retry-After values when a rolling quota is
// exhausted. Sleeping on one verbatim would hold one of the sync pool's two
// worker slots for minutes or hours, behind a modal the user cannot cancel.
// Clamp it: the playlist is recorded incomplete and repaired on a later run,
// which is strictly better than an unbounded stall.
const RETRY_MAX_SLEEP_MS = 30000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Spotify's Retry-After is authoritative when present. Otherwise back off
// exponentially with jitter — without jitter, every worker that was rejected in the
// same window wakes at the same instant and recreates the burst that caused it.
function computeBackoffMs(attempt, retryAfterSeconds, random = Math.random) {
    if (retryAfterSeconds !== null && retryAfterSeconds !== undefined) {
        return Math.min(Math.round(retryAfterSeconds * 1000), RETRY_MAX_SLEEP_MS);
    }
    const base = RETRY_BASE_MS * Math.pow(2, attempt - 1);
    return Math.min(Math.round(base * (1 + RETRY_JITTER_FRACTION * random())), RETRY_MAX_SLEEP_MS);
}

function isRetryable(error) {
    return error.kind === 'rate_limit' || error.kind === 'network' || error.status >= 500;
}

// The single point every Spotify request passes through, for one attempt. Throws
// SpotifyApiError on any non-2xx or transport failure. Retrying is the job of
// spotifyFetch below, which wraps this.
async function spotifyFetchOnce(path, { method = 'GET', body = null, onApiCall = null } = {}) {
    const token = getAccessToken();
    if (!token) {
        throw new SpotifyApiError('No access token available', { status: 0, kind: 'auth' });
    }

    const startedAt = Date.now();
    let response;

    try {
        response = await fetch(`${SPOTIFY_API_BASE}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined
        });
    } catch (err) {
        if (onApiCall) {
            onApiCall({ path, method, status: 0, rateLimited: false, durationMs: Date.now() - startedAt });
        }
        throw new SpotifyApiError(err.message, { status: 0, kind: 'network' });
    }

    if (onApiCall) {
        onApiCall({
            path,
            method,
            status: response.status,
            rateLimited: response.status === 429,
            durationMs: Date.now() - startedAt
        });
    }

    if (!response.ok) {
        throw new SpotifyApiError(
            `Spotify API error: ${response.status} ${response.statusText}`,
            {
                status: response.status,
                retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
                kind: classifyStatus(response.status)
            }
        );
    }

    if (response.status === 204) {
        return null;
    }

    try {
        return await response.json();
    } catch (err) {
        // A 200 with an unparseable body would otherwise escape as a raw
        // SyntaxError and be mis-typed as kind 'http' further downstream.
        throw new SpotifyApiError(`Malformed JSON in Spotify response: ${err.message}`, {
            status: response.status,
            kind: 'http'
        });
    }
}

async function spotifyFetchWithRetry(path, { method = 'GET', body = null, onApiCall = null, maxAttempts = RETRY_MAX_ATTEMPTS, sleep = defaultSleep } = {}) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await spotifyFetchOnce(path, { method, body, onApiCall });
        } catch (err) {
            lastError = err;
            if (!isRetryable(err) || attempt === maxAttempts) throw err;
            await sleep(computeBackoffMs(attempt, err.retryAfter));
        }
    }

    throw lastError;
}

// Refresh this long before the stated expiry, so a request in flight at the
// boundary is not the one that finds out.
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

// Access tokens last an hour, but the page can stay open far longer. Without this,
// every call after the first hour failed with 401 until a reload.
async function spotifyFetch(path, options = {}) {
    if (accessTokenExpiresAt !== null && Date.now() >= accessTokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS) {
        // A failure here is not final: the request's own 401 path below decides.
        await refreshAccessToken();
    }

    try {
        return await spotifyFetchWithRetry(path, options);
    } catch (err) {
        // 403 is a permission problem, not expiry; refreshing cannot fix it.
        const expired = err.status === 401 || (err.kind === 'auth' && err.status === 0);
        if (!expired) throw err;

        const token = await refreshAccessToken();
        if (!token) {
            // No usable refresh token left means only signing in again can help.
            // Otherwise the refresh failed transiently and the session survives.
            if (!readRefreshToken()) {
                err.sessionExpired = true;
                notifySessionExpired();
            }
            throw err;
        }

        // One refresh per request. A 401 with a brand-new token is thrown as-is.
        return await spotifyFetchWithRetry(path, options);
    }
}

async function getUserPlaylistsPage({ limit = 50, offset = 0, onApiCall = null } = {}) {
    return await spotifyFetch(`/me/playlists?limit=${limit}&offset=${offset}`, { onApiCall });
}

async function getPlaylistItems(playlistId, { limit = 50, offset = 0, onApiCall = null } = {}) {
    return await spotifyFetch(`/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`, { onApiCall });
}

async function addItemsToPlaylist(playlistId, uris) {
    return await spotifyFetch(`/playlists/${playlistId}/items`, { method: 'POST', body: { uris } });
}

// Test seam only — production code sets access_token through isAuthorized().
function __setAccessTokenForTests(token, expiresAt = null) {
    access_token = token;
    accessTokenExpiresAt = expiresAt;
}

const clientId = "c4145d13614447e9b3bcd287499086f4";
const spotifyApi = new SpotifyWebApi();

export {
    isAuthorized,
    authorizeSpotify,
    getSpotifyApi,
    getAccessToken,
    getUserPlaylistsPage,
    getPlaylistItems,
    addItemsToPlaylist,
    spotifyFetch,
    onSessionExpired,
    SpotifyApiError,
    __setAccessTokenForTests,
    computeBackoffMs,
    RETRY_MAX_ATTEMPTS,
    RETRY_MAX_SLEEP_MS
};