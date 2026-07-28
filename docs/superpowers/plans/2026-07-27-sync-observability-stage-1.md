# Spotify Sync Observability — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Spotify sync observable — a progress backdrop that surfaces failures and a per-playlist sync-state store that makes truncation detectable — without changing the network behavior we are trying to measure.

**Architecture:** Sync logic moves out of `App.jsx` into an event-emitting engine (`src/sync/`) that does not import React. A pure reducer turns the engine's event stream into view state; a presentational component renders it. IndexedDB goes to v3 by adding a `syncState` store — playlist records are left untouched. Every Spotify call routes through one instrumented `spotifyFetch()` chokepoint that throws typed errors.

**Tech Stack:** React 18, Create React App (`react-scripts` 5), MUI 6, `idb` 8, Jest + jsdom (via `react-scripts test`), `fake-indexeddb`, bun.

Design spec: [`../specs/2026-07-27-spotify-sync-observability-design.md`](../specs/2026-07-27-spotify-sync-observability-design.md)

## Global Constraints

- **Stage 1 must not change network behavior.** No retry, no bounded concurrency, no header staleness window, no pruning, no repair execution. These are Stage 2. Preserving them is the entire point of this stage — see "The critical ordering constraint" in the spec.
- **A partial track list is never recorded as `complete`.** Completeness means the pagination loop reached `next === null` with zero errors. Nothing else.
- `tracksTotal` is a diagnostic only, never a completeness test — unavailable tracks, local files, and podcast episodes are filtered out, so healthy playlists legitimately store fewer tracks than `tracks.total`.
- IndexedDB database name is `playlist-planner`, target version **3**. The v3
  upgrade is **additive only** — it creates the `syncState` store and rewrites
  nothing. Track normalization was cut from scope after the Stage 0 audit measured
  duplication at 1.53× and total usage at 1.8 MB of a 10.2 GB quota. `playlists`
  keeps its existing `trackList` shape; there is no `tracks` store and no
  `trackRefs`.
- **Emptiness is never a skip signal.** Stage 0 found 440 playlists holding
  `trackList: []` that the old code skipped forever because `[]` is truthy. Any
  check for "do I already have this playlist's data" must test `.length`, never
  presence: `if (existing?.trackList?.length)`, never `if (existing?.trackList)`.
- Spotify API base is `https://api.spotify.com/v1`.
- The backdrop **blocks** the app, as today. Non-blocking sync is explicitly out of scope.
- Do not touch `src/getsongbpm.js`, `api/getsongbpm/`, `getTracksNeedingBpmAnalysis`, or `getStorageStats`. They are dead but out of scope.
- Theme colors: green `#1DB954`, amber `#ffaa00`, red `#ff5252`, background `#121212`, paper `#282828`.
- Package manager is **bun**. Tests run one-shot with `CI=true`.
- Commit after every task.

---

### Task 1: Test infrastructure

There are currently zero test files. This task proves the harness runs before anything depends on it.

**Files:**
- Modify: `package.json` (devDependencies)
- Create: `src/setupTests.js`
- Test: `src/setupTests.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: a working `react-scripts test` harness with `fake-indexeddb` auto-installed, so every later task can open a real IndexedDB in Jest.

- [ ] **Step 1: Install test dependencies**

```bash
cd /home/karl/personal-projects/spotify-playlist-planner
bun add -d fake-indexeddb @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 2: Create the Jest setup file**

CRA automatically loads `src/setupTests.js` before every test file. Importing `fake-indexeddb/auto` replaces the global `indexedDB` with an in-memory implementation.

```javascript
// src/setupTests.js
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom';

// Each test file gets a fresh IndexedDB. Without this, databases opened in one
// test file leak into the next and version upgrades fire unpredictably.
beforeEach(() => {
    const { IDBFactory } = require('fake-indexeddb');
    global.indexedDB = new IDBFactory();
});
```

- [ ] **Step 3: Write a test that proves the harness works**

```javascript
// src/setupTests.test.js
import * as idb from 'idb';

test('jest runs and fake-indexeddb is available', async () => {
    const db = await idb.openDB('harness-check', 1, {
        upgrade(upgradeDb) {
            upgradeDb.createObjectStore('things', { keyPath: 'id' });
        }
    });

    await db.put('things', { id: 'a', value: 1 });
    const stored = await db.get('things', 'a');

    expect(stored).toEqual({ id: 'a', value: 1 });
    db.close();
});
```

- [ ] **Step 4: Run the test**

Run: `CI=true bunx react-scripts test --testPathPattern=setupTests`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/setupTests.js src/setupTests.test.js
git commit -m "test: add jest harness with fake-indexeddb"
```

---

### Task 2: Stage 0 — audit the existing cache

Zero code changes to the app. This measures the damage already sitting in IndexedDB and answers how large this library actually is. **Run this before any schema change** — the v3 migration rewrites the data being measured.

**Files:**
- Create: `scripts/audit-indexeddb.js`
- Modify: `docs/superpowers/specs/2026-07-27-spotify-sync-observability-design.md` (record results)

**Interfaces:**
- Consumes: nothing
- Produces: baseline numbers recorded in the spec — playlist count, class-playlist count, unique track count, duplication factor, and the count of playlists whose stored tracks fall short of `tracks.total`.

- [ ] **Step 1: Write the audit snippet**

This is pasted into the browser devtools console on a page where the app has already synced. It reads the **v2** schema (`trackList`), so it must run before Task 4.

```javascript
// scripts/audit-indexeddb.js
//
// Paste into the devtools console on the running app. Read-only — opens the
// database at its current version and never triggers an upgrade.
(async () => {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('playlist-planner');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    const playlists = await new Promise((resolve, reject) => {
        const request = db.transaction('playlists').objectStore('playlists').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    const dateRegex = /([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/;
    const libraryRegex = /\[LIBRARY\]/;
    const uniqueTrackIds = new Set();
    let totalTrackEntries = 0;
    let missingTrackList = 0;
    const suspicious = [];

    for (const playlist of playlists) {
        if (!playlist.trackList) {
            missingTrackList++;
            continue;
        }
        totalTrackEntries += playlist.trackList.length;
        for (const track of playlist.trackList) {
            if (track?.id) uniqueTrackIds.add(track.id);
        }

        const expected = playlist.tracks?.total ?? null;
        const stored = playlist.trackList.length;
        // A multiple of 50 that falls short of the header total is the signature
        // of a pagination loop that broke mid-flight.
        if (expected !== null && stored < expected) {
            suspicious.push({
                name: playlist.name,
                stored,
                expected,
                shortfall: expected - stored,
                endsOnPageBoundary: stored > 0 && stored % 50 === 0
            });
        }
    }

    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {};

    console.log('=== PLAYLISTS ===');
    console.table({
        total: playlists.length,
        library: playlists.filter(p => libraryRegex.test(p.name) || libraryRegex.test(p.description || '')).length,
        class: playlists.filter(p => dateRegex.test(p.name)).length,
        missingTrackList
    });

    console.log('=== TRACKS ===');
    console.table({
        totalEntries: totalTrackEntries,
        unique: uniqueTrackIds.size,
        duplicationFactor: uniqueTrackIds.size
            ? (totalTrackEntries / uniqueTrackIds.size).toFixed(2)
            : 'n/a'
    });

    console.log('=== STORAGE ===');
    console.table({
        usedMB: estimate.usage ? (estimate.usage / 1024 / 1024).toFixed(1) : 'unknown',
        quotaMB: estimate.quota ? (estimate.quota / 1024 / 1024).toFixed(0) : 'unknown'
    });

    console.log(`=== SHORT OF tracks.total: ${suspicious.length} of ${playlists.length} ===`);
    console.log(`  ...of which end exactly on a 50-track page boundary: ${suspicious.filter(s => s.endsOnPageBoundary).length}`);
    console.table(suspicious.slice(0, 40));

    db.close();
    return { playlists: playlists.length, uniqueTracks: uniqueTrackIds.size, suspicious: suspicious.length };
})();
```

- [ ] **Step 2: Run it against the real app**

Start the dev server, open the app, let it finish its normal load, then paste the snippet into the console.

```bash
bun run dev
```

Expected: four tables in the console. Note especially the **page-boundary count** — playlists stopping at an exact multiple of 50 while short of `tracks.total` are almost certainly 429 truncations, not legitimately-filtered unavailable tracks.

- [ ] **Step 3: Record results in the spec**

Append a `## Stage 0 results` section to the design doc with the real numbers: playlist counts, unique tracks, duplication factor, storage used, and how many playlists are short of `tracks.total` (with the page-boundary subset called out).

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-indexeddb.js docs/superpowers/specs/2026-07-27-spotify-sync-observability-design.md
git commit -m "chore: add IndexedDB audit script and record stage 0 baseline"
```

---

### Task 3: Typed Spotify errors and a single fetch chokepoint

Every Spotify call routes through one function so failures are classifiable and countable. **No retry logic** — this stage only makes failures legible.

**Files:**
- Modify: `src/spotify.js`
- Test: `src/spotify.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class SpotifyApiError extends Error` with `.status` (number), `.retryAfter` (number of seconds or `null`), `.kind` (`'rate_limit' | 'auth' | 'network' | 'http'`)
  - `spotifyFetch(path, { method, body, onApiCall }) => Promise<object|null>` — `path` is relative to `https://api.spotify.com/v1`; `onApiCall` is an optional `(info) => void` callback invoked once per HTTP request
  - `getUserPlaylistsPage({ limit, offset, onApiCall }) => Promise<{ items, total, next }>`
  - `getPlaylistItems(playlistId, { limit, offset, onApiCall }) => Promise<{ items, total, next }>`
  - `addItemsToPlaylist(playlistId, uris) => Promise<object|null>`

- [ ] **Step 1: Write the failing tests**

```javascript
// src/spotify.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=spotify`
Expected: FAIL — `SpotifyApiError is not exported` / `spotifyFetch is not a function`.

- [ ] **Step 3: Add the chokepoint to `src/spotify.js`**

Insert after the existing `getAccessToken` function (around line 238), replacing the current `getPlaylistItems` and `addItemsToPlaylist` implementations entirely.

```javascript
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

// The single point every Spotify request passes through. Throws SpotifyApiError
// on any non-2xx or transport failure. Deliberately does NOT retry — retry lands
// in stage 2, and adding it here would invalidate the stage 1 baseline.
async function spotifyFetch(path, { method = 'GET', body = null, onApiCall = null } = {}) {
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

    return await response.json();
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
function __setAccessTokenForTests(token) {
    access_token = token;
}
```

- [ ] **Step 4: Update the export list**

Replace the final export line of `src/spotify.js`:

```javascript
export {
    isAuthorized,
    authorizeSpotify,
    getSpotifyApi,
    getAccessToken,
    getUserPlaylistsPage,
    getPlaylistItems,
    addItemsToPlaylist,
    spotifyFetch,
    SpotifyApiError,
    __setAccessTokenForTests
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=spotify`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/spotify.js src/spotify.test.js
git commit -m "feat: route spotify calls through instrumented chokepoint with typed errors"
```

---

### Task 4: IndexedDB v3 — add the `syncState` store

Additive migration. No playlist record is rewritten and no track data moves. Every
pre-existing playlist is seeded `status: 'never'` — Stage 0 measured 78 % of cached
data as damaged with no way to tell which records from the inside, so none of it is
trusted.

**Files:**
- Modify: `src/database.js:1-26` (init and upgrade), `setPlaylists`, `setPlaylistNoOverwrite`
- Test: `src/database.migration.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: database `playlist-planner` at version 3 with the existing stores
  (`playlists`, `tracksAudioFeatures`, `artists`) plus `syncState` (keyPath
  `playlistId`). New accessors: `getSyncState(playlistId)`,
  `getAllSyncStates()`, `putSyncState(state)`, `deletePlaylists(playlistIds)`.
  `playlists` records keep their v2 `trackList` shape.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/database.migration.test.js
import * as idb from 'idb';
import * as database from './database.js';

const sharedTrack = {
    id: 'track-shared',
    name: 'Shared Song',
    artists: [{ name: 'Artist A' }],
    duration_ms: 210000,
    added_at: new Date('2026-01-15T00:00:00Z')
};

// Builds a v2 database matching the pre-migration schema exactly.
async function seedV2Database() {
    const db = await idb.openDB('playlist-planner', 2, {
        upgrade(upgradeDb) {
            upgradeDb.createObjectStore('playlists', { keyPath: 'id' });
            upgradeDb.createObjectStore('tracksAudioFeatures', { keyPath: 'id' });
            upgradeDb.createObjectStore('artists', { keyPath: 'id' });
        }
    });

    await db.put('playlists', {
        id: 'pl-full',
        name: '2026-01-15 Ride',
        description: '',
        snapshot_id: 'snap-1',
        tracks: { total: 2 },
        trackList: [
            sharedTrack,
            {
                id: 'track-only-1',
                name: 'Solo Song',
                artists: [{ name: 'Artist B' }],
                duration_ms: 180000,
                added_at: new Date('2026-01-16T00:00:00Z')
            }
        ]
    });

    // The dominant real-world damage shape: a first-page 429 stored [].
    await db.put('playlists', {
        id: 'pl-empty',
        name: '2026-02-01 Ride',
        description: '',
        snapshot_id: 'snap-2',
        tracks: { total: 41 },
        trackList: []
    });

    db.close();
}

test('migration creates the syncState store', async () => {
    await seedV2Database();
    await database.init();

    expect(await database.getAllSyncStates()).toHaveLength(2);
});

test('migration marks every pre-existing playlist as never synced', async () => {
    await seedV2Database();
    await database.init();

    for (const state of await database.getAllSyncStates()) {
        expect(state.status).toBe('never');
        expect(state.snapshotId).toBeNull();
        expect(state.lastError).toBeNull();
        expect(state.attempts).toBe(0);
    }
});

test('migration records tracksTotal and storedTrackCount for diagnostics', async () => {
    await seedV2Database();
    await database.init();

    expect(await database.getSyncState('pl-full')).toMatchObject({
        tracksTotal: 2, storedTrackCount: 2
    });
    expect(await database.getSyncState('pl-empty')).toMatchObject({
        tracksTotal: 41, storedTrackCount: 0
    });
});

test('migration leaves playlist records completely untouched', async () => {
    await seedV2Database();
    await database.init();

    const playlist = await database.getPlaylist('pl-full');

    // Track bodies stay embedded; nothing is normalized out.
    expect(playlist.trackList).toHaveLength(2);
    expect(playlist.trackList[0]).toEqual(sharedTrack);
    expect(playlist.trackList[0].added_at).toBeInstanceOf(Date);
    expect(playlist.trackRefs).toBeUndefined();
});

test('opens cleanly on a fresh database with no v2 data', async () => {
    await database.init();

    expect(await database.getPlaylists()).toEqual([]);
    expect(await database.getAllSyncStates()).toEqual([]);
});

test('setPlaylists resolves only after its writes are committed', async () => {
    await database.init();

    await database.setPlaylists([
        { id: 'a', name: 'A', snapshot_id: 's1', tracks: { total: 1 } },
        { id: 'b', name: 'B', snapshot_id: 's1', tracks: { total: 1 } }
    ]);

    // Would be flaky if setPlaylists returned before awaiting tx.done.
    expect(await database.getPlaylists()).toHaveLength(2);
});

test('setPlaylists preserves an existing trackList when snapshot_id is unchanged', async () => {
    await database.init();
    await database.setPlaylist({
        id: 'a', name: 'A', snapshot_id: 's1', tracks: { total: 1 }, trackList: [sharedTrack]
    });

    await database.setPlaylists([{ id: 'a', name: 'A renamed', snapshot_id: 's1', tracks: { total: 1 } }]);

    const stored = await database.getPlaylist('a');
    expect(stored.name).toBe('A renamed');
    expect(stored.trackList).toHaveLength(1);
});

test('setPlaylists clears the trackList when snapshot_id changed', async () => {
    await database.init();
    await database.setPlaylist({
        id: 'a', name: 'A', snapshot_id: 's1', tracks: { total: 1 }, trackList: [sharedTrack]
    });

    await database.setPlaylists([{ id: 'a', name: 'A', snapshot_id: 's2', tracks: { total: 1 } }]);

    expect((await database.getPlaylist('a')).trackList).toEqual([]);
});

test('deletePlaylists removes both the playlist and its sync state', async () => {
    await database.init();
    await database.setPlaylist({ id: 'a', name: 'A', snapshot_id: 's1', trackList: [] });
    await database.putSyncState({ playlistId: 'a', status: 'complete' });

    await database.deletePlaylists(['a']);

    expect(await database.getPlaylist('a')).toBeUndefined();
    expect(await database.getSyncState('a')).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=database.migration`
Expected: FAIL — `database.getAllSyncStates is not a function`.

- [ ] **Step 3: Replace `init` and `upgrade` in `src/database.js`**

Replace lines 1-26 of `src/database.js`:

```javascript
import * as idb from 'idb';

let db;

const DB_NAME = 'playlist-planner';
const DB_VERSION = 3;

async function init() {
    db = await idb.openDB(DB_NAME, DB_VERSION, { upgrade });
    console.log(`Opened ${DB_NAME} v${DB_VERSION}`);
}

function upgrade(upgradeDb, oldVersion, newVersion, tx) {
    console.log(`Upgrading DB from v${oldVersion} to v${newVersion}`);

    if (!upgradeDb.objectStoreNames.contains('playlists')) {
        upgradeDb.createObjectStore('playlists', { keyPath: 'id' });
    }
    if (!upgradeDb.objectStoreNames.contains('tracksAudioFeatures')) {
        upgradeDb.createObjectStore('tracksAudioFeatures', { keyPath: 'id' });
    }
    if (!upgradeDb.objectStoreNames.contains('artists')) {
        upgradeDb.createObjectStore('artists', { keyPath: 'id' });
    }
    if (!upgradeDb.objectStoreNames.contains('syncState')) {
        upgradeDb.createObjectStore('syncState', { keyPath: 'playlistId' });
    }

    if (oldVersion > 0 && oldVersion < 3) {
        return seedSyncStateForExistingPlaylists(tx);
    }
}

// Additive migration: reads playlists, writes syncState, never modifies a playlist
// record. Only IDB operations are awaited — awaiting anything else would let the
// versionchange transaction auto-close mid-migration.
//
// Everything is seeded 'never' rather than 'complete'. The Stage 0 audit measured
// 78% of cached playlists as damaged, and a damaged record is indistinguishable
// from a healthy one from the inside, so none of it is trusted.
async function seedSyncStateForExistingPlaylists(tx) {
    const playlistStore = tx.objectStore('playlists');
    const syncStateStore = tx.objectStore('syncState');

    const playlists = await playlistStore.getAll();
    console.log(`Seeding sync state for ${playlists.length} existing playlists`);

    for (const playlist of playlists) {
        await syncStateStore.put({
            playlistId: playlist.id,
            snapshotId: null,
            status: 'never',
            fetchedItemCount: 0,
            storedTrackCount: playlist.trackList?.length ?? 0,
            tracksTotal: playlist.tracks?.total ?? null,
            lastAttemptAt: null,
            lastSuccessAt: null,
            attempts: 0,
            lastError: null
        });
    }
}
```

- [ ] **Step 4: Add the new accessors**

Append before the export line in `src/database.js`:

```javascript
async function getSyncState(playlistId) {
    return await db.get('syncState', playlistId);
}

async function getAllSyncStates() {
    return await db.getAll('syncState');
}

async function putSyncState(state) {
    await db.put('syncState', state);
}

async function deletePlaylists(playlistIds) {
    const tx = db.transaction(['playlists', 'syncState'], 'readwrite');
    for (const playlistId of playlistIds) {
        tx.objectStore('playlists').delete(playlistId);
        tx.objectStore('syncState').delete(playlistId);
    }
    await tx.done;
}
```

- [ ] **Step 5: Fix the unawaited transaction in `setPlaylists`**

Replace `setPlaylists` (currently `src/database.js:36-43`). The existing version never awaits `tx.done`, so it resolves before its writes commit and swallows write errors.

```javascript
async function setPlaylists(playlists) {
    const tx = db.transaction('playlists', 'readwrite');
    const store = tx.objectStore('playlists');

    for (const playlist of playlists) {
        await setPlaylistNoOverwrite(playlist, store);
    }

    await tx.done;
}
```

- [ ] **Step 6: Normalize the cleared-trackList shape in `setPlaylistNoOverwrite`**

Replace `setPlaylistNoOverwrite` (currently `src/database.js:49-62`). The existing version sets `trackList: undefined` on a snapshot change; using `[]` keeps the field's shape consistent everywhere. This is safe **only** because every consumer tests `.length` rather than presence — see Global Constraints.

```javascript
async function setPlaylistNoOverwrite(playlist, store) {
    const existingPlaylist = await store.get(playlist.id);

    if (!existingPlaylist) {
        await store.put({ ...playlist, trackList: [] });
        return;
    }

    if (existingPlaylist.snapshot_id !== playlist.snapshot_id) {
        // Content changed upstream — drop cached tracks so the engine re-fetches.
        await store.put({ ...playlist, trackList: [] });
        return;
    }

    // Unchanged upstream — keep whatever tracks we already have.
    await store.put({ ...playlist, trackList: existingPlaylist.trackList ?? [] });
}
```

- [ ] **Step 7: Update the export list**

```javascript
export {
    init, getPlaylist, getPlaylists, setPlaylist, setPlaylists, clearPlaylists,
    getTrackAudioFeatures, getTracksAudioFeatures, putTrackAudioFeatures,
    getArtist, putArtist, getStorageStats, clearAllData, getTracksNeedingBpmAnalysis,
    getSyncState, getAllSyncStates, putSyncState, deletePlaylists
};
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=database.migration`
Expected: PASS, 9 tests.

- [ ] **Step 9: Commit**

```bash
git add src/database.js src/database.migration.test.js
git commit -m "feat: add syncState store (db v3) and await playlist write transactions"
```

---

### Task 5: Sync state transitions

The domain rules that decide what counts as complete. `src/database.js` holds raw IndexedDB access; this module holds the logic.

**Files:**
- Create: `src/sync/syncState.js`
- Test: `src/sync/syncState.test.js`

**Interfaces:**
- Consumes: `database.getSyncState`, `database.putSyncState`, `database.getAllSyncStates`
- Produces:
  - `SYNC_STATUS = { NEVER: 'never', COMPLETE: 'complete', INCOMPLETE: 'incomplete', FAILED: 'failed' }`
  - `createSyncState(playlistId) => state`
  - `recordAttempt(playlistId) => Promise<state>`
  - `recordSuccess(playlistId, { snapshotId, fetchedItemCount, storedTrackCount, tracksTotal, reachedEnd }) => Promise<state>`
  - `recordFailure(playlistId, { error, fetchedItemCount, storedTrackCount, tracksTotal, snapshotId }) => Promise<state>`
  - `needsSync(state, playlistHeader) => boolean`
  - `getPlaylistIdsNeedingRepair(playlistHeadersById) => Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

```javascript
// src/sync/syncState.test.js
import * as database from '../database.js';
import {
    SYNC_STATUS, createSyncState, recordAttempt, recordSuccess, recordFailure,
    needsSync, getPlaylistIdsNeedingRepair
} from './syncState.js';

beforeEach(async () => {
    await database.init();
});

test('a completed pagination run records complete', async () => {
    const state = await recordSuccess('pl-1', {
        snapshotId: 'snap-1',
        fetchedItemCount: 112,
        storedTrackCount: 110,
        tracksTotal: 112,
        reachedEnd: true
    });

    expect(state.status).toBe(SYNC_STATUS.COMPLETE);
    expect(state.lastError).toBeNull();
    expect(state.lastSuccessAt).toEqual(expect.any(Number));
});

test('a run that stopped before the last page records incomplete, NOT complete', async () => {
    const state = await recordSuccess('pl-1', {
        snapshotId: 'snap-1',
        fetchedItemCount: 50,
        storedTrackCount: 50,
        tracksTotal: 112,
        reachedEnd: false
    });

    expect(state.status).toBe(SYNC_STATUS.INCOMPLETE);
    expect(state.lastSuccessAt).toBeNull();
});

test('storing fewer tracks than tracksTotal is still complete when pagination finished', async () => {
    // Unavailable tracks, local files, and episodes are filtered out, so a healthy
    // playlist legitimately stores fewer tracks than its header reports.
    const state = await recordSuccess('pl-1', {
        snapshotId: 'snap-1',
        fetchedItemCount: 112,
        storedTrackCount: 98,
        tracksTotal: 112,
        reachedEnd: true
    });

    expect(state.status).toBe(SYNC_STATUS.COMPLETE);
});

test('a rate-limited failure that fetched some pages records incomplete with cause', async () => {
    const error = Object.assign(new Error('429'), { kind: 'rate_limit', status: 429 });

    const state = await recordFailure('pl-1', {
        error,
        fetchedItemCount: 50,
        storedTrackCount: 50,
        tracksTotal: 112,
        snapshotId: 'snap-1'
    });

    expect(state.status).toBe(SYNC_STATUS.INCOMPLETE);
    expect(state.lastError).toEqual({ kind: 'rate_limit', status: 429, message: '429' });
});

test('a failure that fetched nothing records failed', async () => {
    const error = Object.assign(new Error('boom'), { kind: 'network', status: 0 });

    const state = await recordFailure('pl-1', {
        error, fetchedItemCount: 0, storedTrackCount: 0, tracksTotal: 112, snapshotId: 'snap-1'
    });

    expect(state.status).toBe(SYNC_STATUS.FAILED);
});

test('recordAttempt increments attempts and stamps lastAttemptAt', async () => {
    await recordAttempt('pl-1');
    const state = await recordAttempt('pl-1');

    expect(state.attempts).toBe(2);
    expect(state.lastAttemptAt).toEqual(expect.any(Number));
});

test('needsSync is true when the playlist has never been synced', () => {
    expect(needsSync(createSyncState('pl-1'), { id: 'pl-1', snapshot_id: 'snap-1' })).toBe(true);
});

test('needsSync is false for a complete playlist at the same snapshot', () => {
    const state = { ...createSyncState('pl-1'), status: SYNC_STATUS.COMPLETE, snapshotId: 'snap-1' };

    expect(needsSync(state, { id: 'pl-1', snapshot_id: 'snap-1' })).toBe(false);
});

test('needsSync is true for a complete playlist whose snapshot changed', () => {
    const state = { ...createSyncState('pl-1'), status: SYNC_STATUS.COMPLETE, snapshotId: 'snap-1' };

    expect(needsSync(state, { id: 'pl-1', snapshot_id: 'snap-2' })).toBe(true);
});

test('needsSync is true for an incomplete playlist even at the same snapshot', () => {
    const state = { ...createSyncState('pl-1'), status: SYNC_STATUS.INCOMPLETE, snapshotId: 'snap-1' };

    expect(needsSync(state, { id: 'pl-1', snapshot_id: 'snap-1' })).toBe(true);
});

test('getPlaylistIdsNeedingRepair returns only playlists that are not complete', async () => {
    await recordSuccess('pl-good', {
        snapshotId: 'snap-1', fetchedItemCount: 10, storedTrackCount: 10, tracksTotal: 10, reachedEnd: true
    });
    await recordSuccess('pl-bad', {
        snapshotId: 'snap-2', fetchedItemCount: 50, storedTrackCount: 50, tracksTotal: 112, reachedEnd: false
    });

    const ids = await getPlaylistIdsNeedingRepair({
        'pl-good': { id: 'pl-good', snapshot_id: 'snap-1' },
        'pl-bad': { id: 'pl-bad', snapshot_id: 'snap-2' }
    });

    expect(ids).toEqual(['pl-bad']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/syncState`
Expected: FAIL — cannot resolve `./syncState.js`.

- [ ] **Step 3: Implement `src/sync/syncState.js`**

```javascript
import * as database from '../database.js';

const SYNC_STATUS = {
    NEVER: 'never',
    COMPLETE: 'complete',
    INCOMPLETE: 'incomplete',
    FAILED: 'failed'
};

function createSyncState(playlistId) {
    return {
        playlistId,
        snapshotId: null,
        status: SYNC_STATUS.NEVER,
        fetchedItemCount: 0,
        storedTrackCount: 0,
        tracksTotal: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        attempts: 0,
        lastError: null
    };
}

async function loadOrCreate(playlistId) {
    return (await database.getSyncState(playlistId)) ?? createSyncState(playlistId);
}

async function recordAttempt(playlistId) {
    const state = await loadOrCreate(playlistId);
    const next = { ...state, attempts: state.attempts + 1, lastAttemptAt: Date.now() };
    await database.putSyncState(next);
    return next;
}

// `reachedEnd` is the ONLY thing that makes a playlist complete. Comparing stored
// tracks against tracksTotal would wrongly flag every playlist containing a local
// file, an unavailable track, or a podcast episode.
async function recordSuccess(playlistId, { snapshotId, fetchedItemCount, storedTrackCount, tracksTotal, reachedEnd }) {
    const state = await loadOrCreate(playlistId);

    const next = {
        ...state,
        snapshotId,
        status: reachedEnd ? SYNC_STATUS.COMPLETE : SYNC_STATUS.INCOMPLETE,
        fetchedItemCount,
        storedTrackCount,
        tracksTotal,
        lastSuccessAt: reachedEnd ? Date.now() : state.lastSuccessAt,
        lastError: reachedEnd ? null : state.lastError
    };

    await database.putSyncState(next);
    return next;
}

async function recordFailure(playlistId, { error, fetchedItemCount, storedTrackCount, tracksTotal, snapshotId }) {
    const state = await loadOrCreate(playlistId);

    const next = {
        ...state,
        snapshotId,
        // Partial data is INCOMPLETE (repairable, some pages landed); nothing at
        // all is FAILED. Neither is ever COMPLETE.
        status: fetchedItemCount > 0 ? SYNC_STATUS.INCOMPLETE : SYNC_STATUS.FAILED,
        fetchedItemCount,
        storedTrackCount,
        tracksTotal,
        lastError: {
            kind: error?.kind ?? 'http',
            status: error?.status ?? 0,
            message: error?.message ?? String(error)
        }
    };

    await database.putSyncState(next);
    return next;
}

function needsSync(state, playlistHeader) {
    if (!state) return true;
    if (state.status !== SYNC_STATUS.COMPLETE) return true;
    return state.snapshotId !== playlistHeader.snapshot_id;
}

async function getPlaylistIdsNeedingRepair(playlistHeadersById) {
    const states = await database.getAllSyncStates();

    return states
        .filter((state) => {
            const header = playlistHeadersById[state.playlistId];
            if (!header) return false;
            return needsSync(state, header);
        })
        .map((state) => state.playlistId);
}

export {
    SYNC_STATUS, createSyncState, recordAttempt, recordSuccess, recordFailure,
    needsSync, getPlaylistIdsNeedingRepair
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/syncState`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/syncState.js src/sync/syncState.test.js
git commit -m "feat: add sync state transitions with pagination-based completeness"
```

---

### Task 6: Extract `buildTrackLibrary` as a pure function

Currently `App.jsx:298-372`, where it mutates the track objects it reads — a real
bug, not just a style issue: `track.lists += ...` and `track.plays = []` decorate
objects that came straight out of IndexedDB, and it overwrites `playlistTrack.added_at`
with the class date. Normalizing was going to fix this incidentally; with
normalization cut, the extracted function fixes it directly by building fresh view
models and never writing to its inputs.

**Files:**
- Create: `src/trackLibrary.js`
- Test: `src/trackLibrary.test.js`
- Modify: `src/App.jsx:298-372` (the original is deleted in Task 10)

**Interfaces:**
- Consumes: nothing (pure — callers pass stored playlists in)
- Produces: `buildTrackLibrary(libraryPlaylists, classPlaylists, now) => Array<{ id, name, artists, duration_ms, added_at, lists, plays, recencyScore }>`
  and `CLASS_DATE_REGEX`. Both playlist arguments are stored playlist records
  carrying `trackList: [{ id, added_at, name, artists, duration_ms }]`. `now` is a
  millisecond timestamp, injected so tests are deterministic.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/trackLibrary.test.js
import { buildTrackLibrary } from './trackLibrary.js';

const NOW = new Date('2026-07-27T00:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000);

const track = (id, name, added_at) => ({
    id, name, artists: [{ name: 'Artist ' + id }], duration_ms: 200000, added_at
});

const libraryPlaylist = (trackList, name = '[LIBRARY] Main') => ({ id: 'lib-' + name, name, trackList });
const classPlaylist = (name, trackList) => ({ id: name, name, trackList });

test('flattens library playlist tracks into the library', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])], [], NOW
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 't1', name: 'Alpha', duration_ms: 200000 });
});

test('joins names of every library playlist a track appears on', () => {
    const result = buildTrackLibrary(
        [
            libraryPlaylist([track('t1', 'Alpha', daysAgo(10))], '[LIBRARY] One'),
            libraryPlaylist([track('t1', 'Alpha', daysAgo(9))], '[LIBRARY] Two')
        ],
        [], NOW
    );

    expect(result).toHaveLength(1);
    expect(result[0].lists).toBe('[LIBRARY] One,[LIBRARY] Two');
});

test('scores recency from the class playlist date, not from added_at', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(300))])],
        [classPlaylist('2026-07-25 Ride', [track('t1', 'Alpha', daysAgo(300))])],
        NOW
    );

    // 2026-07-25 is 2 days before NOW -> within 7 days -> 10 points.
    expect(result[0].recencyScore).toBe(10);
});

test('accumulates recency across multiple plays', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(300))])],
        [
            classPlaylist('2026-07-25 Ride', [track('t1', 'Alpha', daysAgo(2))]),   // 10
            classPlaylist('2026-07-01 Ride', [track('t1', 'Alpha', daysAgo(26))]),  // 5
            classPlaylist('2026-05-01 Ride', [track('t1', 'Alpha', daysAgo(87))])   // 2
        ],
        NOW
    );

    expect(result[0].recencyScore).toBe(17);
    expect(result[0].plays).toHaveLength(3);
});

test('ignores class-playlist tracks that are not in any library playlist', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])],
        [classPlaylist('2026-07-25 Ride', [track('t2', 'Beta', daysAgo(2))])],
        NOW
    );

    expect(result.map(t => t.id)).toEqual(['t1']);
    expect(result[0].plays).toHaveLength(0);
});

test('tolerates playlists with an empty track list', () => {
    // 440 playlists are in exactly this state until stage 2 repairs them.
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])],
        [classPlaylist('2026-07-25 Ride', [])],
        NOW
    );

    expect(result).toHaveLength(1);
    expect(result[0].recencyScore).toBe(0);
});

test('sorts by recency ascending, then by added_at descending', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([
            track('t1', 'Alpha', daysAgo(10)),
            track('t2', 'Beta', daysAgo(20))
        ])],
        [classPlaylist('2026-07-25 Ride', [track('t1', 'Alpha', daysAgo(2))])],
        NOW
    );

    // t2 has no plays (score 0) so it sorts ahead of t1 (score 10).
    expect(result.map(t => t.id)).toEqual(['t2', 't1']);
});

test('does not mutate the stored playlist objects it reads', () => {
    // This is the bug being fixed: the original decorated IndexedDB-loaded objects
    // in place, so a second call in one session accumulated duplicate list names.
    const stored = track('t1', 'Alpha', daysAgo(10));
    const storedInClass = track('t1', 'Alpha', daysAgo(10));
    const library = [libraryPlaylist([stored])];
    const classes = [classPlaylist('2026-07-25 Ride', [storedInClass])];

    buildTrackLibrary(library, classes, NOW);

    expect(stored).not.toHaveProperty('plays');
    expect(stored).not.toHaveProperty('lists');
    expect(stored).not.toHaveProperty('recencyScore');
    // The class date must NOT be written back over the stored added_at.
    expect(storedInClass.added_at).toEqual(daysAgo(10));
});

test('is idempotent — calling twice yields identical results', () => {
    const library = [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))], '[LIBRARY] One')];
    const classes = [classPlaylist('2026-07-25 Ride', [track('t1', 'Alpha', daysAgo(2))])];

    const first = buildTrackLibrary(library, classes, NOW);
    const second = buildTrackLibrary(library, classes, NOW);

    expect(second).toEqual(first);
    expect(second[0].lists).toBe('[LIBRARY] One');
    expect(second[0].recencyScore).toBe(10);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=trackLibrary`
Expected: FAIL — cannot resolve `./trackLibrary.js`.

- [ ] **Step 3: Implement `src/trackLibrary.js`**

```javascript
const CLASS_DATE_REGEX = /([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/;

const RECENCY_TIERS = [
    { days: 7, points: 10 },
    { days: 30, points: 5 },
    { days: 90, points: 2 },
    { days: 180, points: 1 }
];

function scoreRecency(playedAtMs, now) {
    for (const tier of RECENCY_TIERS) {
        if (playedAtMs > now - tier.days * 24 * 60 * 60 * 1000) {
            return tier.points;
        }
    }
    return 0;
}

/**
 * Builds the flat track list the table renders.
 *
 * Pure: every returned row is a fresh object. The stored playlist records passed
 * in are never written to — the original decorated them in place, so a second call
 * within one session accumulated duplicate list names and overwrote added_at.
 *
 * @param {Array}  libraryPlaylists stored playlists carrying trackList
 * @param {Array}  classPlaylists   stored playlists carrying trackList
 * @param {number} now              millisecond timestamp, injected for testability
 */
function buildTrackLibrary(libraryPlaylists, classPlaylists, now) {
    const trackMap = new Map();

    for (const playlist of libraryPlaylists) {
        for (const storedTrack of playlist.trackList ?? []) {
            if (!storedTrack?.id) continue;

            const existing = trackMap.get(storedTrack.id);
            if (existing) {
                existing.lists += ',' + playlist.name;
                continue;
            }

            trackMap.set(storedTrack.id, {
                id: storedTrack.id,
                name: storedTrack.name,
                artists: storedTrack.artists,
                duration_ms: storedTrack.duration_ms,
                added_at: storedTrack.added_at,
                lists: playlist.name,
                plays: [],
                recencyScore: 0
            });
        }
    }

    for (const playlist of classPlaylists) {
        const dateMatch = CLASS_DATE_REGEX.exec(playlist.name);
        const playlistDateMs = dateMatch ? new Date(dateMatch[1]).getTime() : null;

        for (const storedTrack of playlist.trackList ?? []) {
            const track = trackMap.get(storedTrack?.id);
            if (!track) continue;

            const playedAtMs = playlistDateMs ?? new Date(storedTrack.added_at).getTime();
            const points = scoreRecency(playedAtMs, now);

            track.recencyScore += points;
            // A new object every time — the class date is the real play date, but
            // writing it back onto the stored track was the original bug.
            track.plays.push({
                playlistId: playlist.id,
                playlistName: playlist.name,
                added_at: new Date(playedAtMs),
                recencyScore: points
            });
        }
    }

    return Array.from(trackMap.values()).sort(
        (a, b) => a.recencyScore - b.recencyScore || b.added_at - a.added_at
    );
}

export { buildTrackLibrary, CLASS_DATE_REGEX };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=trackLibrary`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/trackLibrary.js src/trackLibrary.test.js
git commit -m "feat: extract buildTrackLibrary as a pure, non-mutating function"
```

---

### Task 7: Telemetry reducer

Turns the engine's event stream into the exact shape the backdrop renders. Pure and synchronous, so every UI state is testable without running a sync.

**Files:**
- Create: `src/sync/telemetry.js`
- Test: `src/sync/telemetry.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PHASES = [{ key, label }]` — `'headers' | 'library' | 'class' | 'repair'`
  - `initialTelemetry() => state`
  - `reduceTelemetry(state, event) => state`
  - Event shapes: `{ type: 'sync:start' }`, `{ type: 'sync:complete' }`, `{ type: 'phase:start', phase, total }`, `{ type: 'phase:progress', phase, done?, total? }`, `{ type: 'phase:complete', phase }`, `{ type: 'item:start', phase, playlistId, name }`, `{ type: 'item:success', phase, playlistId, name, trackCount, durationMs }`, `{ type: 'item:error', phase, playlistId, name, cause, storedTrackCount, tracksTotal }`, `{ type: 'api:call', phase, rateLimited }`, `{ type: 'tick', at }`

  `phase:progress` exists because `phase:start` resets `done` to 0 and flips status
  to `active`. Two callers need to update counts without either side effect: the
  header phase discovers its true total only as it paginates, and the Stage 1
  repair phase must report a queue size while staying visually `pending`.
  - State shape: `{ running, startedAt, elapsedMs, phases, feed, stats, incomplete }`

- [ ] **Step 1: Write the failing tests**

```javascript
// src/sync/telemetry.test.js
import { initialTelemetry, reduceTelemetry, PHASES, FEED_LIMIT } from './telemetry.js';

const apply = (events, state = initialTelemetry()) => events.reduce(reduceTelemetry, state);

test('starts with every phase pending and zeroed stats', () => {
    const state = initialTelemetry();

    expect(state.running).toBe(false);
    expect(state.phases).toHaveLength(PHASES.length);
    expect(state.phases.every(p => p.status === 'pending')).toBe(true);
    expect(state.stats).toEqual({ apiCalls: 0, rateLimited: 0, failed: 0, tracksCached: 0 });
});

test('sync:start marks running and stamps startedAt', () => {
    const state = apply([{ type: 'sync:start', at: 1000 }]);

    expect(state.running).toBe(true);
    expect(state.startedAt).toBe(1000);
});

test('phase:start sets the phase active with its total', () => {
    const state = apply([{ type: 'sync:start', at: 0 }, { type: 'phase:start', phase: 'class', total: 306 }]);
    const phase = state.phases.find(p => p.key === 'class');

    expect(phase.status).toBe('active');
    expect(phase.total).toBe(306);
    expect(phase.done).toBe(0);
});

test('item:success increments done and tracksCached', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 2 },
        { type: 'item:success', phase: 'class', playlistId: 'a', name: 'A', trackCount: 46, durationMs: 310 }
    ]);

    expect(state.phases.find(p => p.key === 'class').done).toBe(1);
    expect(state.stats.tracksCached).toBe(46);
});

test('item:error increments the phase failure count and global failed stat', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 2 },
        {
            type: 'item:error', phase: 'class', playlistId: 'b', name: 'B',
            cause: { kind: 'rate_limit', status: 429 }, storedTrackCount: 50, tracksTotal: 112
        }
    ]);

    expect(state.phases.find(p => p.key === 'class').failed).toBe(1);
    expect(state.stats.failed).toBe(1);
});

test('item:error records an incomplete entry describing the cause', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 1 },
        {
            type: 'item:error', phase: 'class', playlistId: 'b', name: '2026-07-10 Recovery',
            cause: { kind: 'rate_limit', status: 429 }, storedTrackCount: 50, tracksTotal: 112
        }
    ]);

    expect(state.incomplete).toEqual([{
        playlistId: 'b',
        name: '2026-07-10 Recovery',
        cause: { kind: 'rate_limit', status: 429 },
        storedTrackCount: 50,
        tracksTotal: 112
    }]);
});

test('api:call counts calls and rate limits, globally and per phase', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 1 },
        { type: 'api:call', phase: 'class', rateLimited: false },
        { type: 'api:call', phase: 'class', rateLimited: true }
    ]);

    expect(state.stats.apiCalls).toBe(2);
    expect(state.stats.rateLimited).toBe(1);
    expect(state.phases.find(p => p.key === 'class').apiCalls).toBe(2);
});

test('the feed keeps newest first and is capped', () => {
    const events = [{ type: 'sync:start', at: 0 }, { type: 'phase:start', phase: 'class', total: 100 }];
    for (let i = 0; i < FEED_LIMIT + 10; i++) {
        events.push({
            type: 'item:success', phase: 'class', playlistId: `p${i}`, name: `P${i}`,
            trackCount: 1, durationMs: 10
        });
    }

    const state = apply(events);

    expect(state.feed).toHaveLength(FEED_LIMIT);
    expect(state.feed[0].name).toBe(`P${FEED_LIMIT + 9}`);
});

test('phase:progress updates counts without resetting done or changing status', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'headers', total: 50 },
        { type: 'item:success', phase: 'headers', playlistId: 'a', name: 'A', trackCount: 0, durationMs: 1 },
        { type: 'phase:progress', phase: 'headers', total: 312 }
    ]);
    const phase = state.phases.find(p => p.key === 'headers');

    expect(phase.total).toBe(312);
    expect(phase.done).toBe(1);       // NOT reset
    expect(phase.status).toBe('active');
});

test('phase:progress on a pending phase leaves it pending', () => {
    // The stage 1 repair phase reports a queue size without claiming to be running.
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:progress', phase: 'repair', total: 2 }
    ]);
    const phase = state.phases.find(p => p.key === 'repair');

    expect(phase.total).toBe(2);
    expect(phase.status).toBe('pending');
});

test('phase:complete marks the phase done', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'headers', total: 1 },
        { type: 'phase:complete', phase: 'headers' }
    ]);

    expect(state.phases.find(p => p.key === 'headers').status).toBe('complete');
});

test('tick updates elapsedMs while running', () => {
    const state = apply([{ type: 'sync:start', at: 1000 }, { type: 'tick', at: 4500 }]);

    expect(state.elapsedMs).toBe(3500);
});

test('sync:complete stops the run', () => {
    const state = apply([{ type: 'sync:start', at: 0 }, { type: 'sync:complete', at: 5000 }]);

    expect(state.running).toBe(false);
    expect(state.elapsedMs).toBe(5000);
});

test('unknown events pass through without changing state', () => {
    const before = apply([{ type: 'sync:start', at: 0 }]);
    const after = reduceTelemetry(before, { type: 'nonsense' });

    expect(after).toBe(before);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/telemetry`
Expected: FAIL — cannot resolve `./telemetry.js`.

- [ ] **Step 3: Implement `src/sync/telemetry.js`**

```javascript
const PHASES = [
    { key: 'headers', label: 'Playlist headers' },
    { key: 'library', label: 'Library playlists' },
    { key: 'class', label: 'Class playlists' },
    { key: 'repair', label: 'Repair incomplete playlists' }
];

const FEED_LIMIT = 50;

function initialTelemetry() {
    return {
        running: false,
        startedAt: null,
        elapsedMs: 0,
        phases: PHASES.map(({ key, label }) => ({
            key,
            label,
            status: 'pending',
            done: 0,
            total: 0,
            failed: 0,
            apiCalls: 0,
            elapsedMs: 0,
            startedAt: null
        })),
        feed: [],
        stats: { apiCalls: 0, rateLimited: 0, failed: 0, tracksCached: 0 },
        incomplete: []
    };
}

function updatePhase(state, phaseKey, updater) {
    return {
        ...state,
        phases: state.phases.map((phase) => (phase.key === phaseKey ? updater(phase) : phase))
    };
}

function pushFeed(state, entry) {
    return { ...state, feed: [entry, ...state.feed].slice(0, FEED_LIMIT) };
}

function reduceTelemetry(state, event) {
    switch (event.type) {
        case 'sync:start':
            return { ...initialTelemetry(), running: true, startedAt: event.at };

        case 'sync:complete':
            return {
                ...state,
                running: false,
                elapsedMs: state.startedAt === null ? state.elapsedMs : event.at - state.startedAt
            };

        case 'tick':
            if (!state.running || state.startedAt === null) return state;
            return { ...state, elapsedMs: event.at - state.startedAt };

        case 'phase:start':
            return updatePhase(state, event.phase, (phase) => ({
                ...phase,
                status: 'active',
                total: event.total,
                done: 0,
                startedAt: event.at ?? null
            }));

        // Updates counts only. Never resets `done`, never changes `status` — see
        // the header and repair phases in syncEngine for why both matter.
        case 'phase:progress':
            return updatePhase(state, event.phase, (phase) => ({
                ...phase,
                done: event.done ?? phase.done,
                total: event.total ?? phase.total
            }));

        case 'phase:complete':
            return updatePhase(state, event.phase, (phase) => ({
                ...phase,
                status: 'complete',
                elapsedMs: phase.startedAt !== null && event.at ? event.at - phase.startedAt : phase.elapsedMs
            }));

        case 'item:start':
            return pushFeed(state, {
                playlistId: event.playlistId,
                name: event.name,
                status: 'active',
                detail: 'fetching…'
            });

        case 'item:success': {
            const withPhase = updatePhase(state, event.phase, (phase) => ({ ...phase, done: phase.done + 1 }));
            const withStats = {
                ...withPhase,
                stats: { ...withPhase.stats, tracksCached: withPhase.stats.tracksCached + event.trackCount }
            };
            return pushFeed(withStats, {
                playlistId: event.playlistId,
                name: event.name,
                status: 'success',
                detail: `${event.trackCount} tracks · ${event.durationMs}ms`
            });
        }

        case 'item:error': {
            const withPhase = updatePhase(state, event.phase, (phase) => ({
                ...phase,
                done: phase.done + 1,
                failed: phase.failed + 1
            }));
            const withStats = {
                ...withPhase,
                stats: { ...withPhase.stats, failed: withPhase.stats.failed + 1 },
                incomplete: [
                    ...withPhase.incomplete,
                    {
                        playlistId: event.playlistId,
                        name: event.name,
                        cause: event.cause,
                        storedTrackCount: event.storedTrackCount,
                        tracksTotal: event.tracksTotal
                    }
                ]
            };
            return pushFeed(withStats, {
                playlistId: event.playlistId,
                name: event.name,
                status: 'error',
                detail: describeCause(event.cause, event.storedTrackCount, event.tracksTotal)
            });
        }

        case 'api:call': {
            const withPhase = updatePhase(state, event.phase, (phase) => ({
                ...phase,
                apiCalls: phase.apiCalls + 1
            }));
            return {
                ...withPhase,
                stats: {
                    ...withPhase.stats,
                    apiCalls: withPhase.stats.apiCalls + 1,
                    rateLimited: withPhase.stats.rateLimited + (event.rateLimited ? 1 : 0)
                }
            };
        }

        default:
            return state;
    }
}

// A 429 truncation and a token expiry need different fixes, so the UI names the
// cause rather than only counting failures.
function describeCause(cause, storedTrackCount, tracksTotal) {
    if (!cause) return 'failed';

    if (cause.kind === 'rate_limit') {
        return tracksTotal
            ? `rate limited · stopped at ${storedTrackCount} of ${tracksTotal}`
            : `rate limited · stopped at ${storedTrackCount}`;
    }
    if (cause.kind === 'auth') return 'token expired mid-fetch';
    if (cause.kind === 'network') return 'network error';
    return `HTTP ${cause.status}`;
}

export { PHASES, FEED_LIMIT, initialTelemetry, reduceTelemetry, describeCause };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/telemetry`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/telemetry.js src/sync/telemetry.test.js
git commit -m "feat: add pure telemetry reducer for sync progress"
```

---

### Task 8: Sync engine (Stage 1 behavior)

Orchestrates the four phases and emits telemetry. **Deliberately preserves the
current network defects** — unbounded fan-out, `break` on error, headers only when
empty, no pruning, repair listed but not executed.

One thing it does NOT preserve: the `[]`-is-truthy skip bug. Stage 0 measured that
as the single largest source of damage (440 playlists permanently empty), and it is
a storage-correctness defect rather than network behavior, so fixing it does not
compromise the baseline. Every "do I have this already" check tests `.length`.

**Files:**
- Create: `src/sync/syncEngine.js`
- Test: `src/sync/syncEngine.test.js`

**Interfaces:**
- Consumes: `spotify.getUserPlaylistsPage`, `spotify.getPlaylistItems`, `database.*`, `syncState.*`, `trackLibrary.CLASS_DATE_REGEX`
- Produces: `runSync({ emit, spotifyClient }) => Promise<{ libraryPlaylists, classPlaylists }>`. `emit` is `(event) => void`; `spotifyClient` defaults to the real module and is injected in tests.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/sync/syncEngine.test.js
import * as database from '../database.js';
import { runSync } from './syncEngine.js';
import { SYNC_STATUS } from './syncState.js';

function makeItem(id) {
    return {
        added_at: '2026-01-15T00:00:00Z',
        item: { id, name: 'Track ' + id, artists: [{ name: 'Artist' }], duration_ms: 200000 }
    };
}

const header = (id, name, total, snapshot = 's1') => ({
    id, name, description: '', snapshot_id: snapshot, tracks: { total }
});

// Minimal fake honouring the same contract as src/spotify.js.
function makeClient({ playlists, itemsByPlaylist, failOn = {} }) {
    return {
        getUserPlaylistsPage: async ({ offset = 0, onApiCall }) => {
            if (onApiCall) onApiCall({ status: 200, rateLimited: false });
            return { items: playlists.slice(offset, offset + 50), total: playlists.length, next: null };
        },
        getPlaylistItems: async (playlistId, { offset = 0, onApiCall }) => {
            const failure = failOn[playlistId];
            if (failure && offset === failure.atOffset) {
                if (onApiCall) onApiCall({ status: failure.status, rateLimited: failure.status === 429 });
                throw Object.assign(new Error('boom'), { kind: failure.kind, status: failure.status });
            }
            if (onApiCall) onApiCall({ status: 200, rateLimited: false });
            const all = itemsByPlaylist[playlistId] ?? [];
            const page = all.slice(offset, offset + 50);
            return { items: page, total: all.length, next: offset + page.length < all.length ? 'more' : null };
        }
    };
}

beforeEach(async () => {
    await database.init();
});

test('stores fetched tracks on the playlist record', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 2)],
        itemsByPlaylist: { lib: [makeItem('t1'), makeItem('t2')] }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    const stored = await database.getPlaylist('lib');
    expect(stored.trackList).toHaveLength(2);
    expect(stored.trackList[0]).toMatchObject({ id: 't1', name: 'Track t1', duration_ms: 200000 });
    expect(stored.trackList[0].added_at).toBeInstanceOf(Date);
});

test('a fully paginated playlist is marked complete', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getSyncState('lib')).status).toBe(SYNC_STATUS.COMPLETE);
});

test('a 429 mid-pagination marks the playlist incomplete, never complete', async () => {
    const items = Array.from({ length: 120 }, (_, i) => makeItem('t' + i));
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 120)],
        itemsByPlaylist: { lib: items },
        failOn: { lib: { atOffset: 50, status: 429, kind: 'rate_limit' } }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    const state = await database.getSyncState('lib');
    expect(state.status).toBe(SYNC_STATUS.INCOMPLETE);
    expect(state.lastError.kind).toBe('rate_limit');
    expect(state.storedTrackCount).toBe(50);
});

test('partial data from a 429 is still persisted, just not marked complete', async () => {
    const items = Array.from({ length: 120 }, (_, i) => makeItem('t' + i));
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 120)],
        itemsByPlaylist: { lib: items },
        failOn: { lib: { atOffset: 50, status: 429, kind: 'rate_limit' } }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getPlaylist('lib')).trackList).toHaveLength(50);
});

test('a 429 on the FIRST page stores an empty list marked failed, not complete', async () => {
    // Stage 0's dominant damage shape: 440 class playlists in exactly this state.
    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 41)],
        itemsByPlaylist: { cls: [makeItem('t1')] },
        failOn: { cls: { atOffset: 0, status: 429, kind: 'rate_limit' } }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    const state = await database.getSyncState('cls');
    expect(state.status).toBe(SYNC_STATUS.FAILED);
    expect(state.storedTrackCount).toBe(0);
});

test('a playlist holding an EMPTY trackList is re-fetched, not skipped', async () => {
    // The []-is-truthy bug: the old code skipped these forever.
    await database.setPlaylist({ ...header('cls', '2026-07-25 Ride', 1), trackList: [] });

    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { cls: [makeItem('t1')] }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getPlaylist('cls')).trackList).toHaveLength(1);
    expect((await database.getSyncState('cls')).status).toBe(SYNC_STATUS.COMPLETE);
});

test('a playlist that already has tracks is not re-fetched', async () => {
    await database.setPlaylist({
        ...header('cls', '2026-07-25 Ride', 1),
        trackList: [{ id: 'cached', name: 'Cached', artists: [], duration_ms: 1, added_at: new Date() }]
    });

    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { cls: [makeItem('t1')] }
    });
    const spy = jest.spyOn(client, 'getPlaylistItems');

    await runSync({ emit: () => {}, spotifyClient: client });

    expect(spy).not.toHaveBeenCalled();
    expect((await database.getPlaylist('cls')).trackList[0].id).toBe('cached');
});

test('STAGE 1: does not retry after a 429 — one attempt per playlist', async () => {
    const items = Array.from({ length: 120 }, (_, i) => makeItem('t' + i));
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 120)],
        itemsByPlaylist: { lib: items },
        failOn: { lib: { atOffset: 50, status: 429, kind: 'rate_limit' } }
    });
    const spy = jest.spyOn(client, 'getPlaylistItems');

    await runSync({ emit: () => {}, spotifyClient: client });

    // offset 0 succeeds, offset 50 throws, loop breaks. Exactly two calls.
    expect(spy).toHaveBeenCalledTimes(2);
});

test('STAGE 1: repair phase reports its queue but does not execute', async () => {
    const items = Array.from({ length: 120 }, (_, i) => makeItem('t' + i));
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 120)],
        itemsByPlaylist: { lib: items },
        failOn: { lib: { atOffset: 50, status: 429, kind: 'rate_limit' } }
    });
    const events = [];

    await runSync({ emit: (e) => events.push(e), spotifyClient: client });

    const repairProgress = events.find(e => e.type === 'phase:progress' && e.phase === 'repair');
    expect(repairProgress.total).toBe(1);
    // No work was done in the repair phase, and it never claimed to be running.
    expect(events.some(e => e.phase === 'repair' && e.type === 'item:start')).toBe(false);
    expect(events.some(e => e.phase === 'repair' && e.type === 'phase:start')).toBe(false);
});

test('splits playlists into library and class buckets', async () => {
    const client = makeClient({
        playlists: [
            header('lib', '[LIBRARY] Main', 1),
            header('cls', '2026-07-25 Ride', 1),
            header('other', 'Random Mix', 1)
        ],
        itemsByPlaylist: { lib: [makeItem('t1')], cls: [makeItem('t1')], other: [makeItem('t9')] }
    });

    const result = await runSync({ emit: () => {}, spotifyClient: client });

    expect(result.libraryPlaylists.map(p => p.id)).toEqual(['lib']);
    expect(result.classPlaylists.map(p => p.id)).toEqual(['cls']);
});

test('emits api:call for every request, tagged with its phase', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });
    const events = [];

    await runSync({ emit: (e) => events.push(e), spotifyClient: client });

    const apiCalls = events.filter(e => e.type === 'api:call');
    expect(apiCalls.some(e => e.phase === 'headers')).toBe(true);
    expect(apiCalls.some(e => e.phase === 'library')).toBe(true);
});

test('filters out null items, local files, and episodes', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 3)],
        itemsByPlaylist: {
            lib: [makeItem('t1'), { added_at: '2026-01-01T00:00:00Z', item: null }, null]
        }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getPlaylist('lib')).trackList).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/syncEngine`
Expected: FAIL — cannot resolve `./syncEngine.js`.

- [ ] **Step 3: Implement `src/sync/syncEngine.js`**

```javascript
import * as spotify from '../spotify.js';
import * as database from '../database.js';
import { CLASS_DATE_REGEX } from '../trackLibrary.js';
import { recordAttempt, recordSuccess, recordFailure, getPlaylistIdsNeedingRepair } from './syncState.js';

const LIBRARY_REGEX = /\[LIBRARY\]/;
const PAGE_SIZE = 50;

/**
 * Runs a full sync and returns the playlists the UI needs.
 *
 * STAGE 1 — deliberately preserves the existing network behavior so the baseline
 * measures the real problem. Specifically: unbounded fan-out, no retry, headers
 * fetched only when the store is empty, no pruning, and a repair phase that
 * reports its queue without executing. All of this changes in stage 2.
 */
async function runSync({ emit, spotifyClient = spotify }) {
    emit({ type: 'sync:start', at: Date.now() });

    const headers = await syncPlaylistHeaders({ emit, spotifyClient });

    for (const header of headers) {
        header.isClassPlaylist = CLASS_DATE_REGEX.test(header.name);
    }

    const libraryHeaders = headers.filter(
        (playlist) => LIBRARY_REGEX.test(playlist.name) || LIBRARY_REGEX.test(playlist.description ?? '')
    );
    const classHeaders = headers.filter((playlist) => CLASS_DATE_REGEX.test(playlist.name));

    const libraryPlaylists = await syncPlaylistBatch(libraryHeaders, 'library', { emit, spotifyClient });
    libraryPlaylists.sort((a, b) => a.name.localeCompare(b.name));

    const classPlaylists = await syncPlaylistBatch(classHeaders, 'class', { emit, spotifyClient });
    classPlaylists.sort((a, b) => b.name.localeCompare(a.name));

    await reportRepairQueue(headers, { emit });

    emit({ type: 'sync:complete', at: Date.now() });

    return { libraryPlaylists, classPlaylists };
}

async function syncPlaylistHeaders({ emit, spotifyClient }) {
    emit({ type: 'phase:start', phase: 'headers', total: 0, at: Date.now() });

    const stored = await database.getPlaylists();

    // STAGE 1: only fetches when the store is completely empty, exactly as today.
    // Stage 2 replaces this with a staleness window.
    if (stored.length > 0) {
        emit({ type: 'phase:progress', phase: 'headers', done: stored.length, total: stored.length });
        emit({ type: 'phase:complete', phase: 'headers', at: Date.now() });
        return stored;
    }

    const headers = [];
    let offset = 0;
    let more = true;

    while (more) {
        const page = await spotifyClient.getUserPlaylistsPage({
            limit: PAGE_SIZE,
            offset,
            onApiCall: (info) => emit({ type: 'api:call', phase: 'headers', rateLimited: info.rateLimited })
        });

        // Spotify intermittently returns nulls in this array.
        headers.push(...page.items.filter((playlist) => playlist != null));
        offset += page.items.length;
        more = page.next !== null;

        // phase:progress, not phase:start — the latter would reset `done` to 0 on
        // every page. The header phase counts playlists discovered, not fetched,
        // so nothing is pushed to the feed here.
        emit({ type: 'phase:progress', phase: 'headers', done: headers.length, total: page.total });
    }

    await database.setPlaylists(headers);
    emit({ type: 'phase:complete', phase: 'headers', at: Date.now() });

    return await database.getPlaylists();
}

async function syncPlaylistBatch(headers, phase, { emit, spotifyClient }) {
    emit({ type: 'phase:start', phase, total: headers.length, at: Date.now() });

    // STAGE 1: unbounded fan-out, exactly as today. This is the single largest
    // contributor to the 429 rate and the baseline needs to capture it.
    const playlists = await Promise.all(
        headers.map((header) => syncOnePlaylist(header, phase, { emit, spotifyClient }))
    );

    emit({ type: 'phase:complete', phase, at: Date.now() });
    return playlists;
}

async function syncOnePlaylist(header, phase, { emit, spotifyClient }) {
    const existing = await database.getPlaylist(header.id);

    // `.length`, NOT truthiness. An empty array means a previous run failed on the
    // first page; the old code treated [] as "already have it" and skipped these
    // forever, which is how 440 playlists ended up permanently empty.
    if (existing?.trackList?.length) {
        return existing;
    }

    emit({ type: 'item:start', phase, playlistId: header.id, name: header.name });
    await recordAttempt(header.id);

    const startedAt = Date.now();
    const { trackList, fetchedItemCount, reachedEnd, error } = await fetchAllPlaylistItems(
        header.id, phase, { emit, spotifyClient }
    );

    // Partial data is still worth keeping — it just must never be called complete.
    const playlist = { ...header, trackList };
    await database.setPlaylist(playlist);

    const tracksTotal = header.tracks?.total ?? null;

    if (error) {
        await recordFailure(header.id, {
            error,
            fetchedItemCount,
            storedTrackCount: trackList.length,
            tracksTotal,
            snapshotId: header.snapshot_id
        });
        emit({
            type: 'item:error',
            phase,
            playlistId: header.id,
            name: header.name,
            cause: { kind: error.kind ?? 'http', status: error.status ?? 0 },
            storedTrackCount: trackList.length,
            tracksTotal
        });
        return playlist;
    }

    await recordSuccess(header.id, {
        snapshotId: header.snapshot_id,
        fetchedItemCount,
        storedTrackCount: trackList.length,
        tracksTotal,
        reachedEnd
    });
    emit({
        type: 'item:success',
        phase,
        playlistId: header.id,
        name: header.name,
        trackCount: trackList.length,
        durationMs: Date.now() - startedAt
    });

    return playlist;
}

async function fetchAllPlaylistItems(playlistId, phase, { emit, spotifyClient }) {
    const trackList = [];
    let fetchedItemCount = 0;
    let offset = 0;
    let more = true;
    let reachedEnd = false;
    let error = null;

    while (more) {
        let page;
        try {
            page = await spotifyClient.getPlaylistItems(playlistId, {
                limit: PAGE_SIZE,
                offset,
                onApiCall: (info) => emit({ type: 'api:call', phase, rateLimited: info.rateLimited })
            });
        } catch (err) {
            // STAGE 1: break without retrying, exactly as today. What is new is
            // that the caller now records WHY we stopped.
            error = err;
            break;
        }

        fetchedItemCount += page.items.length;

        for (const entry of page.items) {
            // Nulls, local files, unavailable tracks, and podcast episodes.
            if (!entry?.item?.id) continue;

            trackList.push({
                id: entry.item.id,
                added_at: new Date(entry.added_at),
                name: entry.item.name,
                artists: entry.item.artists,
                duration_ms: entry.item.duration_ms
            });
        }

        offset += page.items.length;
        more = page.next !== null;
        if (!more) reachedEnd = true;
    }

    return { trackList, fetchedItemCount, reachedEnd, error };
}

// STAGE 1: reports what WOULD be repaired without repairing it. Executing here
// would fix the damage mid-baseline and destroy the measurement.
async function reportRepairQueue(headers, { emit }) {
    const headersById = Object.fromEntries(headers.map((header) => [header.id, header]));
    const needingRepair = await getPlaylistIdsNeedingRepair(headersById);

    // phase:progress, not phase:start — the phase must stay visually `pending`
    // while still reporting its queue size, since it does no work in stage 1.
    emit({ type: 'phase:progress', phase: 'repair', total: needingRepair.length });
    return needingRepair;
}

export { runSync };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/syncEngine`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/syncEngine.js src/sync/syncEngine.test.js
git commit -m "feat: add instrumented sync engine preserving stage 1 network behavior"
```

---

### Task 9: `SyncBackdrop` component

Renders telemetry state. Purely presentational — takes state, renders it, owns nothing but the expand toggle.

**Files:**
- Create: `src/components/SyncBackdrop.jsx`
- Test: `src/components/SyncBackdrop.test.jsx`

**Interfaces:**
- Consumes: telemetry state from `reduceTelemetry`
- Produces: `<SyncBackdrop telemetry={state} />`

- [ ] **Step 1: Write the failing tests**

```javascript
// src/components/SyncBackdrop.test.jsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SyncBackdrop from './SyncBackdrop.jsx';
import { initialTelemetry, reduceTelemetry } from '../sync/telemetry.js';

const apply = (events) => events.reduce(reduceTelemetry, initialTelemetry());

const cleanRun = apply([
    { type: 'sync:start', at: 0 },
    { type: 'phase:start', phase: 'class', total: 2 },
    { type: 'item:success', phase: 'class', playlistId: 'a', name: '2026-07-15 Intervals', trackCount: 46, durationMs: 310 }
]);

const failedRun = apply([
    { type: 'sync:start', at: 0 },
    { type: 'phase:start', phase: 'class', total: 2 },
    {
        type: 'item:error', phase: 'class', playlistId: 'b', name: '2026-07-10 Recovery',
        cause: { kind: 'rate_limit', status: 429 }, storedTrackCount: 50, tracksTotal: 112
    }
]);

test('shows every phase label when collapsed', () => {
    render(<SyncBackdrop telemetry={cleanRun} />);

    expect(screen.getByText('Playlist headers')).toBeInTheDocument();
    expect(screen.getByText('Class playlists')).toBeInTheDocument();
    expect(screen.getByText('Repair incomplete playlists')).toBeInTheDocument();
});

test('a clean run shows no failure badge', () => {
    render(<SyncBackdrop telemetry={cleanRun} />);

    expect(screen.queryByTestId('phase-failures-class')).not.toBeInTheDocument();
});

test('a failed run shows a failure badge on the affected phase', () => {
    render(<SyncBackdrop telemetry={failedRun} />);

    expect(screen.getByTestId('phase-failures-class')).toHaveTextContent('1 FAILED');
});

test('details are hidden until expanded', () => {
    render(<SyncBackdrop telemetry={failedRun} />);

    expect(screen.queryByTestId('sync-details')).not.toBeInTheDocument();
});

test('expanding reveals the stats block and an incomplete callout naming the cause', async () => {
    render(<SyncBackdrop telemetry={failedRun} />);

    await userEvent.click(screen.getByRole('button', { name: /show details/i }));

    const details = screen.getByTestId('sync-details');
    expect(details).toBeInTheDocument();
    expect(within(details).getByText(/1 playlist incomplete/i)).toBeInTheDocument();
    // Scoped to the details block: the same cause text also appears in the feed,
    // which lives outside it, so an unscoped query would match twice and throw.
    expect(within(details).getByText(/rate limited · stopped at 50 of 112/i)).toBeInTheDocument();
});

test('the cause appears in both the feed and the callout', async () => {
    render(<SyncBackdrop telemetry={failedRun} />);

    await userEvent.click(screen.getByRole('button', { name: /show details/i }));

    expect(screen.getAllByText(/rate limited · stopped at 50 of 112/i)).toHaveLength(2);
});

test('expanded stats line reports api calls and rate limits', async () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'class', total: 1 },
        { type: 'api:call', phase: 'class', rateLimited: true },
        { type: 'api:call', phase: 'class', rateLimited: false }
    ]);
    render(<SyncBackdrop telemetry={state} />);

    await userEvent.click(screen.getByRole('button', { name: /show details/i }));

    expect(screen.getByTestId('stat-apiCalls')).toHaveTextContent('2');
    expect(screen.getByTestId('stat-rateLimited')).toHaveTextContent('1');
});
```

- [ ] **Step 2: Install the interaction testing library**

```bash
bun add -d @testing-library/user-event
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=SyncBackdrop`
Expected: FAIL — cannot resolve `./SyncBackdrop.jsx`.

- [ ] **Step 4: Implement `src/components/SyncBackdrop.jsx`**

```jsx
import React, { useState, Fragment } from 'react';
import Backdrop from '@mui/material/Backdrop';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import { describeCause } from '../sync/telemetry.js';

const GREEN = '#1DB954';
const AMBER = '#ffaa00';
const RED = '#ff5252';

function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function overallProgress(phases) {
    const total = phases.reduce((sum, phase) => sum + phase.total, 0);
    const done = phases.reduce((sum, phase) => sum + phase.done, 0);
    return total === 0 ? 0 : Math.round((done / total) * 100);
}

function PhaseIcon({ status }) {
    if (status === 'complete') return <Box component="span" sx={{ color: GREEN, width: 16 }}>✓</Box>;
    if (status === 'active') return <CircularProgress size={13} sx={{ color: GREEN }} />;
    return <Box component="span" sx={{ color: 'rgba(255,255,255,0.35)', width: 16 }}>○</Box>;
}

function FeedRow({ entry }) {
    const color = entry.status === 'error' ? RED : entry.status === 'success' ? GREEN : AMBER;
    const glyph = entry.status === 'error' ? '✕' : entry.status === 'success' ? '✓' : '⏳';

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.5, fontSize: 12.5 }}>
            <Box component="span" sx={{ color, width: 15, textAlign: 'center' }}>{glyph}</Box>
            <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.name}
            </Box>
            <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 11.5, color: 'rgba(255,255,255,0.5)' }}>
                {entry.detail}
            </Box>
        </Box>
    );
}

function SyncBackdrop({ telemetry }) {
    const [expanded, setExpanded] = useState(false);
    const { phases, feed, stats, incomplete, elapsedMs } = telemetry;
    const activePhaseKey = phases.find((phase) => phase.status === 'active')?.key;

    return (
        <Backdrop className="Loader" open={true} sx={{ zIndex: 1300 }}>
            <Box sx={{ backgroundColor: '#121212', borderRadius: '10px', p: 3.5, width: 560, maxWidth: '92vw' }}>
                <Typography sx={{ fontSize: 19, fontWeight: 700 }}>Syncing your library…</Typography>
                <Typography sx={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', mb: 1.5 }}>
                    Elapsed {formatElapsed(elapsedMs)}
                </Typography>

                <LinearProgress
                    variant="determinate"
                    value={overallProgress(phases)}
                    sx={{
                        height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.10)',
                        '& .MuiLinearProgress-bar': { backgroundColor: stats.rateLimited > 0 ? AMBER : GREEN }
                    }}
                />

                <Box sx={{ mt: 1.5 }}>
                    {phases.map((phase) => (
                        <Box key={phase.key} sx={{ py: 1.25, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, fontSize: 14, fontWeight: 600 }}>
                                <PhaseIcon status={phase.status} />
                                <Box component="span" sx={{ color: phase.status === 'pending' ? 'rgba(255,255,255,0.35)' : 'inherit' }}>
                                    {phase.label}
                                </Box>

                                {phase.failed > 0 && (
                                    <Box
                                        data-testid={`phase-failures-${phase.key}`}
                                        sx={{
                                            fontSize: 10.5, fontWeight: 700, px: 0.9, py: 0.25, borderRadius: '9px',
                                            backgroundColor: 'rgba(255,82,82,0.16)', color: '#ff8a8a'
                                        }}
                                    >
                                        {phase.failed} FAILED
                                    </Box>
                                )}

                                <Box sx={{ ml: 'auto', fontFamily: 'monospace', fontSize: 12, fontWeight: 400, color: 'rgba(255,255,255,0.5)' }}>
                                    {phase.status === 'pending' && phase.total > 0 ? `${phase.total} queued`
                                        : phase.status === 'pending' ? 'pending'
                                        : `${phase.done} / ${phase.total}`}
                                    {expanded && phase.apiCalls > 0 ? ` · ${phase.apiCalls} calls` : ''}
                                </Box>
                            </Box>

                            {phase.status === 'active' && (
                                <LinearProgress
                                    variant="determinate"
                                    value={phase.total === 0 ? 0 : Math.round((phase.done / phase.total) * 100)}
                                    sx={{
                                        mt: 0.9, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.10)',
                                        '& .MuiLinearProgress-bar': { backgroundColor: stats.rateLimited > 0 ? AMBER : GREEN }
                                    }}
                                />
                            )}

                            {/* The feed nests under the ACTIVE phase so the phase list stays the spine. */}
                            {expanded && phase.key === activePhaseKey && feed.length > 0 && (
                                <Box sx={{ backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: '6px', px: 1.4, py: 0.9, mt: 1.1 }}>
                                    {feed.slice(0, 6).map((entry, index) => (
                                        <FeedRow key={`${entry.playlistId}-${index}`} entry={entry} />
                                    ))}
                                </Box>
                            )}
                        </Box>
                    ))}
                </Box>

                {expanded && (
                    <Box data-testid="sync-details">
                        {stats.rateLimited > 0 && (
                            <Box sx={{
                                backgroundColor: 'rgba(255,170,0,0.13)', borderLeft: `3px solid ${AMBER}`,
                                px: 1.4, py: 1, borderRadius: '5px', fontSize: 12.5, mt: 1.5, color: '#ffd27a'
                            }}>
                                Rate limited — {stats.rateLimited} of {stats.apiCalls} calls
                                {stats.apiCalls > 0 ? ` (${((stats.rateLimited / stats.apiCalls) * 100).toFixed(1)}%)` : ''}.
                            </Box>
                        )}

                        {incomplete.length > 0 && (
                            <Box sx={{
                                backgroundColor: 'rgba(255,82,82,0.10)', borderLeft: `3px solid ${RED}`,
                                px: 1.4, py: 1.1, borderRadius: '5px', fontSize: 12.5, mt: 1.25
                            }}>
                                <Box sx={{ color: '#ff8a8a', fontWeight: 700 }}>
                                    {incomplete.length} playlist{incomplete.length === 1 ? '' : 's'} incomplete
                                </Box>
                                {incomplete.map((entry) => (
                                    <Box key={entry.playlistId} sx={{ opacity: 0.8, mt: 0.5 }}>
                                        {entry.name} — {describeCause(entry.cause, entry.storedTrackCount, entry.tracksTotal)}
                                    </Box>
                                ))}
                                <Box sx={{ opacity: 0.65, mt: 0.6, fontSize: 11.5 }}>
                                    Marked incomplete in storage; the repair phase will re-fetch them.
                                </Box>
                            </Box>
                        )}

                        <Box sx={{
                            display: 'flex', gap: 2.25, flexWrap: 'wrap', mt: 1.75, pt: 1.6,
                            borderTop: '1px solid rgba(255,255,255,0.07)', fontFamily: 'monospace',
                            fontSize: 12, color: 'rgba(255,255,255,0.55)'
                        }}>
                            <span data-testid="stat-apiCalls"><b style={{ color: '#fff' }}>{stats.apiCalls}</b> API calls</span>
                            <span data-testid="stat-rateLimited"><b style={{ color: AMBER }}>{stats.rateLimited}</b> rate limited</span>
                            <span data-testid="stat-failed"><b style={{ color: RED }}>{stats.failed}</b> failed</span>
                            <span data-testid="stat-tracksCached"><b style={{ color: '#fff' }}>{stats.tracksCached}</b> tracks cached</span>
                        </Box>
                    </Box>
                )}

                <Button
                    fullWidth
                    onClick={() => setExpanded(!expanded)}
                    sx={{
                        mt: 2, py: 1.1, backgroundColor: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.09)', borderRadius: '7px',
                        fontSize: 12.5, color: 'rgba(255,255,255,0.75)', textTransform: 'none'
                    }}
                >
                    {expanded ? '▴ Hide details' : '▾ Show details'}
                </Button>
            </Box>
        </Backdrop>
    );
}

export default SyncBackdrop;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=SyncBackdrop`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/SyncBackdrop.jsx src/components/SyncBackdrop.test.jsx package.json bun.lock
git commit -m "feat: add sync backdrop with progressive disclosure of failures"
```

---

### Task 10: Wire the engine into `App.jsx`

Replaces all sync code in `App.jsx` with the engine, and swaps the old backdrop for `SyncBackdrop`.

**Files:**
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `runSync`, `initialTelemetry`, `reduceTelemetry`, `buildTrackLibrary`, `SyncBackdrop`
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Delete the superseded functions**

Remove these from `src/App.jsx` entirely — every one is now owned by `src/sync/` or `src/trackLibrary.js`:

- `getPlaylistHeaders` (lines 142-156)
- `retrievePlaylistHeaders` (158-182)
- `getPlaylistTracks` (184-207)
- `retrievePlaylistTracks` (209-248)
- `getTracksAudioFeatures` (250-272)
- `retrieveTracksAudioFeatures` (274-296)
- `buildTrackLibrary` (298-372)
- `getData` (384-425)
- the `sleep` helper (130) — only `retrievePlaylistTracks` used it

- [ ] **Step 2: Replace the imports and loading state**

Replace the `loadState` declaration (lines 79-86) and add imports:

```jsx
import { runSync } from './sync/syncEngine.js';
import { initialTelemetry, reduceTelemetry } from './sync/telemetry.js';
import { buildTrackLibrary } from './trackLibrary.js';
import SyncBackdrop from './components/SyncBackdrop.jsx';
```

```jsx
const [telemetry, setTelemetry] = useState(initialTelemetry());
```

Delete the `loadState` state entirely — `telemetry` replaces it.

- [ ] **Step 3: Add the sync driver**

Add alongside the other data-load functions. The `emit` callback funnels engine events through the reducer; a 1s timer drives the elapsed clock.

```jsx
const getData = useCallback(async () => {
    setIsLoading(true);

    // Engine events are pushed through the pure reducer; React only ever sees
    // the reduced view state.
    const emit = (event) => setTelemetry((current) => reduceTelemetry(current, event));
    const ticker = setInterval(() => emit({ type: 'tick', at: Date.now() }), 1000);

    try {
        const { libraryPlaylists, classPlaylists } = await runSync({ emit });

        setLibraryPlaylists(libraryPlaylists);
        setClassPlaylists(classPlaylists);
        setTrackLibrary(buildTrackLibrary(libraryPlaylists, classPlaylists, Date.now()));
    } catch (error) {
        console.error('Sync failed', error);
    } finally {
        clearInterval(ticker);
        setIsLoading(false);
    }
}, []);
```

- [ ] **Step 4: Update `refreshData`**

Replace `refreshData` (lines 374-378). The old version fired an unawaited write and then immediately read the same data back, racing itself.

```jsx
const refreshData = async () => {
    setTrackLibrary([]);
    await getData();
};
```

- [ ] **Step 5: Fix the two `useEffect` hooks**

Replace the effect at lines 108-118 so `getData` is a proper dependency:

```jsx
useEffect(() => {
    if (isSpotifyAuthorized) {
        getData();
    }
}, [isSpotifyAuthorized, getData]);
```

- [ ] **Step 6: Swap in the new backdrop**

Replace the `isLoading ? (...)` block (lines 878-892):

```jsx
{isLoading ? (
    <SyncBackdrop telemetry={telemetry} />
) : isSpotifyAuthorized ? (
```

- [ ] **Step 7: Verify the build compiles clean**

Run: `CI=true bun run build`
Expected: "Compiled successfully." No warnings about unused variables or missing hook dependencies. If any of the deleted functions are still referenced, the build fails here.

- [ ] **Step 8: Run the whole test suite**

Run: `CI=true bunx react-scripts test`
Expected: PASS — all suites green.

- [ ] **Step 9: Commit**

```bash
git add src/App.jsx
git commit -m "feat: drive sync through the instrumented engine and new backdrop"
```

---

### Task 11: Baseline run

Stage 1 is only worth building if we read the numbers off it. This produces the measurement Stage 2 is planned against.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-spotify-sync-observability-design.md`

**Interfaces:**
- Consumes: everything above
- Produces: recorded baseline numbers that determine Stage 2's worker-pool size and backoff strategy

- [ ] **Step 1: Clear stored data and start fresh**

The migration marks everything `never`, so a cold sync happens on first load after upgrade. To force a true cold start instead, delete the database from devtools → Application → IndexedDB → `playlist-planner` → Delete.

- [ ] **Step 2: Run a cold sync with the network tab recording**

```bash
bun run dev
```

Open the app, authorize if needed, and let the sync run to completion. Expand the backdrop partway through to confirm the feed and stats update live.

- [ ] **Step 3: Record the numbers**

From the backdrop's stat line and the network tab:

| Measurement | Source |
| --- | --- |
| Total playlists / library / class | phase totals |
| Wall-clock per phase | phase elapsed |
| Total API calls | `stat-apiCalls` |
| 429 count and rate | `stat-rateLimited` |
| Playlists ending incomplete, by cause | incomplete callout |
| Tracks cached | `stat-tracksCached` |
| Peak concurrent requests | network tab waterfall |
| IndexedDB size | `navigator.storage.estimate()` |

Compare against the Stage 0 figures already recorded in the spec: 628 playlists,
4,348 unique tracks, 445 damaged, 14,608 tracks missing, 1.8 MB used.

- [ ] **Step 4: Append a `## Stage 1 baseline` section to the spec**

Record the table above, plus a one-paragraph read on where time actually went and whether 429s dominate the failures or something else does.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-27-spotify-sync-observability-design.md
git commit -m "docs: record stage 1 baseline sync measurements"
```

---

## What Stage 2 will cover

Planned separately, once the baseline exists:

1. Retry honoring `Retry-After`, with exponential backoff and jitter
2. Bounded worker pool — size chosen from the measured 429 rate
3. Token refresh on 401 and ahead of expiry
4. Header staleness window replacing "only when the store is empty"
5. Pruning playlists deleted from Spotify
6. Executing the repair phase
7. `sort((a, b) => a.name - b.name)` → `localeCompare` (currently `NaN`, a silent no-op)
