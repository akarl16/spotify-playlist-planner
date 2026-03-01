import SpotifyWebApi from "spotify-web-api-js";

let scope = "playlist-read-collaborative playlist-read-private playlist-modify-public playlist-modify-private streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state";
let access_token;

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

function getAuthorizationCodeFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    let code = urlParams.get('code');
    return code;
};

async function retrieveAccessTokenFromAuth(authorization_code) {
    console.debug("retrieveAccessTokenFromAuth");
    let codeVerifier = localStorage.getItem('code_verifier');
    let redirect_url = 'http://127.0.0.1:3000/spotify-playlist-planner';

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

    setWithExpiry('access_token', data.access_token, data.expires_in * 1000);
    localStorage.setItem('refresh_token', data.refresh_token);
    localStorage.removeItem('authorization_code');
    localStorage.removeItem('code_verifier');

    return data.access_token;
}

async function retrieveAccessTokenFromRefresh(refresh_token) {
    console.debug("retrieveAccessTokenFromRefresh");
    let body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
        client_id: clientId,
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

    setWithExpiry('access_token', data.access_token, data.expires_in * 1000);
    localStorage.setItem('refresh_token', data.refresh_token);

    return data.access_token;
}

function authorizeSpotify() {
    let codeVerifier = generateRandomString(128);

    generateCodeChallenge(codeVerifier).then(codeChallenge => {
        let state = generateRandomString(16);
        localStorage.setItem('code_verifier', codeVerifier);
        let redirect_url = 'http://127.0.0.1:3000/spotify-playlist-planner';

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
        window.location.search = "";
    }
    authorization_code = localStorage.getItem('authorization_code');

    access_token = getWithExpiry("access_token");
    
    if (!access_token) {
        console.debug("No access_token found in local storage");
        let refresh_token = localStorage.getItem("refresh_token");
        if(refresh_token) {
            access_token = await retrieveAccessTokenFromRefresh(refresh_token);
            spotifyApi.setAccessToken(access_token);
            return true;
        }
        else if(authorization_code) {
            access_token = await retrieveAccessTokenFromAuth(authorization_code);
            spotifyApi.setAccessToken(access_token);
            return true;
        }
    } else {
        console.debug("Token found in storage");
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

/**
 * Get playlist tracks using the updated Feb 2026 API endpoint.
 * Replaces the deprecated spotifyApi.getPlaylistTracks() which uses /tracks
 * @param playlistId - The Spotify playlist ID
 * @param options - Object with limit and offset properties
 * @returns Promise with items array and pagination info
 */
async function getPlaylistItems(playlistId, options = {}) {
    const { limit = 50, offset = 0 } = options;
    const token = getAccessToken();
    
    if (!token) {
        throw new Error('No access token available');
    }
    
    const url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`;
    
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });
    
    if (!response.ok) {
        throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
}

/**
 * Add tracks to playlist using the updated Feb 2026 API endpoint.
 * Replaces the deprecated spotifyApi.addTracksToPlaylist() which uses /tracks
 * @param playlistId - The Spotify playlist ID
 * @param uris - Array of Spotify track URIs
 * @returns Promise with response data
 */
async function addItemsToPlaylist(playlistId, uris) {
    const token = getAccessToken();
    
    if (!token) {
        throw new Error('No access token available');
    }
    
    const url = `https://api.spotify.com/v1/playlists/${playlistId}/items`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            uris: uris
        })
    });
    
    if (!response.ok) {
        throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
}

const clientId = "c4145d13614447e9b3bcd287499086f4";
const spotifyApi = new SpotifyWebApi();

export { isAuthorized, authorizeSpotify, getSpotifyApi, getAccessToken, getPlaylistItems, addItemsToPlaylist }