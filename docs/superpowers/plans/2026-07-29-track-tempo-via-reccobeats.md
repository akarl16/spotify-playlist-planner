# Track Tempo via ReccoBeats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show tempo (BPM) for the ~68 % of the track library ReccoBeats covers, fetched as a fifth sync phase, with the gap surfaced honestly rather than hidden.

**Architecture:** A new `src/reccobeats.js` client mirroring `spotify.js`'s shape — one instrumented chokepoint, typed errors, batched requests. A fifth phase in `src/sync/syncEngine.js`, after repair, reusing the existing worker pool and telemetry. Features land in the `tracksAudioFeatures` IndexedDB store that already exists. `buildTrackLibrary` gains a features map and attaches `tempo` to each row.

**Tech Stack:** React 18, Create React App (`react-scripts` 5), MUI 6, `idb` 8, Jest + jsdom, `fake-indexeddb`, bun.

Design spec: [`../specs/2026-07-27-spotify-sync-observability-design.md`](../specs/2026-07-27-spotify-sync-observability-design.md)

## Why ReccoBeats, and what it costs

Spotify withdrew `/audio-features` in November 2024 (403, no replacement). ReccoBeats was chosen over GetSongBPM, Deezer and the commercial alternatives on measured evidence:

- **It keys off Spotify track IDs**, which are already stored. GetSongBPM only accepts title + artist, which is why `src/getsongbpm.js` is mostly a fuzzy matcher that deliberately returns `null` rather than risk a cover version.
- **No API key, and CORS reflects the origin** — callable straight from the browser, no proxy. Deezer was rejected for exactly this: it fails `Failed to fetch` cross-origin and would work only on the Vercel deployment, not GitHub Pages.
- **Both endpoints batch 40 per request** (41 → HTTP 400), so the whole library costs ~305 requests, not ~5,000.
- **It returns Spotify's exact schema.** Blinding Lights reports `tempo: 171.001` where Spotify's own value was `171.005` — this is not an independent estimate.

### Measured coverage, 2026-07-29

Probed all 7,135 unique tracks in the live library. 179 batches, every one HTTP 200, **zero errors and no rate limiting** at ~8 req/sec.

| Measure | Value |
| --- | --- |
| Unique tracks probed | 7,135 |
| Matched | 4,936 (**69.2 %**) |
| Library-only coverage | 4,153 of 6,085 (**68.2 %**) |
| Features present once matched | 40 of 40 sampled |

Coverage is uniform across the playlists that matter — Cycle Tempo 69 %, Cycle Easy 70 %, Cycle party 70 %, Cycle Openers 68 %. The weakest are themed sets (Wrestlemania 54 %), and the misses skew heavily to WWE entrance themes and small-label edits.

**Roughly 1,930 library tracks will have no tempo.** That is a design constraint, not a footnote — see the Global Constraints.

## API shape

```
GET https://api.reccobeats.com/v1/track?ids=<up to 40 SPOTIFY ids>
  -> { content: [ { id: <reccobeats uuid>, href: "https://open.spotify.com/track/<spotify id>", ... } ] }

GET https://api.reccobeats.com/v1/audio-features?ids=<up to 40 RECCOBEATS uuids>
  -> { content: [ { id, href, tempo, energy, danceability, key, mode, valence,
                    acousticness, instrumentalness, liveness, loudness, speechiness } ] }
```

Unmatched ids are simply absent from `content`. Both responses carry `href`, which is how results map back to Spotify ids — **never rely on response ordering.**

## Global Constraints

- **The 32 % gap must be visible, never silently dropped.** A missing tempo renders as `—`. Any filtering or sorting on tempo must make the excluded count evident. Quietly omitting a third of the library is precisely the failure class the previous two stages existed to eliminate.
- **A track that ReccoBeats does not have is recorded, not retried forever.** Misses are stored with `source: 'reccobeats-notfound'` so the next sync skips them. Without this, every sync re-requests ~1,930 known-absent tracks.
- **Batch size is exactly 40.** 41 returns HTTP 400. One named constant.
- **Map results by `href`, not by array position.** Responses omit misses, so index alignment is wrong.
- **Reuse the existing pool and telemetry.** No new concurrency mechanism; `mapWithConcurrency` with `SYNC_CONCURRENCY` already exists and is measured.
- **`SYNC_CONCURRENCY` stays 2.** Set by measurement; not to be touched.
- The features phase is **excluded from the overall progress bar**, like the headers phase — it counts tracks, not playlists, and mixing units is what made that bar non-monotonic before. It gets its own row and its own bar.
- Do not touch `src/getsongbpm.js` or `api/getsongbpm/` in this plan; their fate is a separate decision.
- IndexedDB stays at **version 3**. The `tracksAudioFeatures` store already exists.
- Package manager is **bun**; tests run one-shot with `CI=true`.
- Commit after every task.

---

### Task 1: ReccoBeats client

**Files:**
- Create: `src/reccobeats.js`
- Test: `src/reccobeats.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class ReccoBeatsApiError extends Error` with `.status` and `.kind` (`'rate_limit' | 'network' | 'http'`)
  - `RECCOBEATS_BATCH_SIZE` = `40`
  - `resolveTrackIds(spotifyIds, { onApiCall }) => Promise<Map<spotifyId, reccobeatsId>>`
  - `fetchAudioFeatures(reccobeatsIds, { onApiCall }) => Promise<Map<spotifyId, features>>` where `features` is `{ tempo, energy, danceability, key, mode, valence, acousticness, instrumentalness, liveness, loudness, speechiness }`

Both take **at most one batch** (≤ 40 ids) and throw if given more — batching across the whole library is the engine's job, so the pool governs it.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/reccobeats.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=reccobeats`
Expected: FAIL — cannot resolve `./reccobeats.js`.

- [ ] **Step 3: Implement `src/reccobeats.js`**

```javascript
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
    const match = /track\/([A-Za-z0-9]+)/.exec(href || '');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=reccobeats`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/reccobeats.js src/reccobeats.test.js
git commit -m "feat: add ReccoBeats client for track audio features"
```

---

### Task 2: Feature storage helpers

**Files:**
- Modify: `src/database.js`
- Test: `src/database.features.test.js`

**Interfaces:**
- Consumes: the existing `tracksAudioFeatures` store
- Produces:
  - `putTrackAudioFeaturesBatch(records)` — one awaited transaction for the whole batch
  - `getTrackIdsMissingAudioFeatures(trackIds) => Promise<string[]>` — ids with no stored record at all. Ids stored as `reccobeats-notfound` count as **present** and are not returned.
  - `getAudioFeaturesMap(trackIds) => Promise<Map<trackId, features>>` — only records that actually carry a tempo

Also deletes `getTracksNeedingBpmAnalysis`, which reads `item.track` against a flat `trackList` and therefore returns `[]` unconditionally. It is unreferenced and superseded.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/database.features.test.js
import * as database from './database.js';

beforeEach(async () => {
    await database.init();
});

test('putTrackAudioFeaturesBatch writes every record and resolves after commit', async () => {
    await database.putTrackAudioFeaturesBatch([
        { id: 'a', tempo: 128, source: 'reccobeats' },
        { id: 'b', tempo: 95, source: 'reccobeats' }
    ]);

    expect(await database.getTrackAudioFeatures('a')).toMatchObject({ tempo: 128 });
    expect(await database.getTrackAudioFeatures('b')).toMatchObject({ tempo: 95 });
});

test('getTrackIdsMissingAudioFeatures returns only ids with no record', async () => {
    await database.putTrackAudioFeaturesBatch([{ id: 'known', tempo: 128, source: 'reccobeats' }]);

    const missing = await database.getTrackIdsMissingAudioFeatures(['known', 'unknown']);

    expect(missing).toEqual(['unknown']);
});

test('a recorded miss is NOT re-requested', async () => {
    // Without this, every sync would re-request ~1,930 known-absent tracks.
    await database.putTrackAudioFeaturesBatch([{ id: 'absent', source: 'reccobeats-notfound' }]);

    const missing = await database.getTrackIdsMissingAudioFeatures(['absent']);

    expect(missing).toEqual([]);
});

test('getAudioFeaturesMap returns only records carrying a tempo', async () => {
    await database.putTrackAudioFeaturesBatch([
        { id: 'a', tempo: 128, energy: 0.8, source: 'reccobeats' },
        { id: 'b', source: 'reccobeats-notfound' }
    ]);

    const map = await database.getAudioFeaturesMap(['a', 'b']);

    expect(map.get('a')).toMatchObject({ tempo: 128, energy: 0.8 });
    expect(map.has('b')).toBe(false);
});

test('getAudioFeaturesMap tolerates ids that were never stored', async () => {
    const map = await database.getAudioFeaturesMap(['never-seen']);

    expect(map.size).toBe(0);
});

test('an empty batch is a no-op', async () => {
    await expect(database.putTrackAudioFeaturesBatch([])).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=database.features`
Expected: FAIL — `database.putTrackAudioFeaturesBatch is not a function`.

- [ ] **Step 3: Add the helpers to `src/database.js`**

Append before the export block:

```javascript
async function putTrackAudioFeaturesBatch(records) {
    if (records.length === 0) return;

    const tx = db.transaction('tracksAudioFeatures', 'readwrite');
    for (const record of records) {
        tx.store.put(record);
    }
    await tx.done;
}

// A stored `reccobeats-notfound` record counts as present. Treating it as missing
// would re-request every known-absent track on every sync — roughly 1,930 of them.
//
// Reads the store ONCE rather than issuing a get per id: this is called with ~7,100
// track ids, and that many sequential IndexedDB round trips is measurably slow.
async function getTrackIdsMissingAudioFeatures(trackIds) {
    const stored = new Set((await db.getAllKeys('tracksAudioFeatures')).map(String));
    return trackIds.filter((trackId) => !stored.has(String(trackId)));
}

async function getAudioFeaturesMap(trackIds) {
    const wanted = new Set(trackIds);
    const map = new Map();

    for (const record of await db.getAll('tracksAudioFeatures')) {
        if (wanted.has(record.id) && typeof record.tempo === 'number') {
            map.set(record.id, record);
        }
    }
    return map;
}
```

- [ ] **Step 4: Delete `getTracksNeedingBpmAnalysis`**

Remove the whole function and its JSDoc block from `src/database.js`, and remove it from the export list. It reads `item.track` against a flat `trackList`, so it returns `[]` unconditionally; nothing references it.

- [ ] **Step 5: Update the export list**

Add `putTrackAudioFeaturesBatch`, `getTrackIdsMissingAudioFeatures`, `getAudioFeaturesMap`; remove `getTracksNeedingBpmAnalysis`.

- [ ] **Step 6: Run the full suite and build**

Run: `CI=true bunx react-scripts test` then `CI=true bun run build`
Expected: all pass; "Compiled successfully", no warnings.

- [ ] **Step 7: Commit**

```bash
git add src/database.js src/database.features.test.js
git commit -m "feat: add audio-feature storage helpers and drop dead BPM query"
```

---

### Task 3: Telemetry — the features phase

**Files:**
- Modify: `src/sync/telemetry.js`
- Test: `src/sync/telemetry.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: a fifth entry in `PHASES` with key `'features'` and label `'Track tempo'`

- [ ] **Step 1: Write the failing tests**

```javascript
test('the features phase exists and starts pending', () => {
    const phase = initialTelemetry().phases.find(p => p.key === 'features');

    expect(phase).toBeDefined();
    expect(phase.label).toBe('Track tempo');
    expect(phase.status).toBe('pending');
});

test('the features phase progresses like any other', () => {
    const state = apply([
        { type: 'sync:start', at: 0 },
        { type: 'phase:start', phase: 'features', total: 100 },
        { type: 'item:success', phase: 'features', playlistId: 'batch-0', name: 'batch 1', trackCount: 40, durationMs: 10 }
    ]);
    const phase = state.phases.find(p => p.key === 'features');

    expect(phase.status).toBe('active');
    expect(phase.done).toBe(1);
    expect(phase.total).toBe(100);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/telemetry`
Expected: FAIL — no `'features'` phase.

- [ ] **Step 3: Add the phase**

In `src/sync/telemetry.js`, append to the `PHASES` array, after the `repair` entry:

```javascript
    { key: 'features', label: 'Track tempo' }
```

No other change — the reducer is generic across phase keys.

- [ ] **Step 4: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/telemetry`
Expected: PASS.

- [ ] **Step 5: Verify the overall bar is unaffected**

Run: `CI=true bunx react-scripts test --testPathPattern=SyncBackdrop`
Expected: PASS. `OVERALL_PHASE_KEYS` is `['library', 'class']`, so the new phase is correctly excluded — it counts tracks, not playlists, and mixing units is what made that bar non-monotonic before.

- [ ] **Step 6: Commit**

```bash
git add src/sync/telemetry.js src/sync/telemetry.test.js
git commit -m "feat: add the track-tempo phase to sync telemetry"
```

---

### Task 4: The features sync phase

**Files:**
- Modify: `src/sync/syncEngine.js`
- Test: `src/sync/syncEngine.test.js`

**Interfaces:**
- Consumes: `reccobeats.resolveTrackIds`, `reccobeats.fetchAudioFeatures`, `database.getTrackIdsMissingAudioFeatures`, `database.putTrackAudioFeaturesBatch`, `mapWithConcurrency`
- Produces: `runSync` additionally returns `featuresById` — a `Map<spotifyTrackId, features>` covering every track in the returned playlists

- [ ] **Step 1: Write the failing tests**

```javascript
test('the features phase fetches tempo for tracks that lack it', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map([['t1', 'rb-1']])),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map([['t1', { tempo: 128 }]]))
    };

    const result = await runSync({ emit: () => {}, spotifyClient: client, reccoClient: recco });

    expect(result.featuresById.get('t1')).toMatchObject({ tempo: 128 });
    expect(await database.getTrackAudioFeatures('t1')).toMatchObject({ tempo: 128, source: 'reccobeats' });
});

test('a track the catalogue lacks is recorded so it is never re-requested', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map()),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };

    await runSync({ emit: () => {}, spotifyClient: client, reccoClient: recco });

    expect(await database.getTrackAudioFeatures('t1')).toMatchObject({ source: 'reccobeats-notfound' });
});

test('tracks with stored features are not requested again', async () => {
    await database.putTrackAudioFeaturesBatch([{ id: 't1', tempo: 128, source: 'reccobeats' }]);

    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map()),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };

    await runSync({ emit: () => {}, spotifyClient: client, reccoClient: recco });

    expect(recco.resolveTrackIds).not.toHaveBeenCalled();
});

test('a recorded miss is not requested again on a later sync', async () => {
    await database.putTrackAudioFeaturesBatch([{ id: 't1', source: 'reccobeats-notfound' }]);

    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map()),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };

    await runSync({ emit: () => {}, spotifyClient: client, reccoClient: recco });

    expect(recco.resolveTrackIds).not.toHaveBeenCalled();
});

test('never asks for more than one batch per request', async () => {
    const items = Array.from({ length: 95 }, (_, i) => makeItem(`t${i}`));
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 95)],
        itemsByPlaylist: { lib: items }
    });
    const seenBatchSizes = [];
    const recco = {
        resolveTrackIds: jest.fn(async (ids) => { seenBatchSizes.push(ids.length); return new Map(); }),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };

    await runSync({ emit: () => {}, spotifyClient: client, reccoClient: recco });

    expect(Math.max(...seenBatchSizes)).toBeLessThanOrEqual(40);
    expect(seenBatchSizes.reduce((a, b) => a + b, 0)).toBe(95);
});

test('a features failure does not fail the whole sync', async () => {
    // Tempo is an enhancement; playlists are the product.
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });
    const recco = {
        resolveTrackIds: jest.fn().mockRejectedValue(
            Object.assign(new Error('boom'), { kind: 'rate_limit', status: 429 })
        ),
        fetchAudioFeatures: jest.fn()
    };

    const result = await runSync({ emit: () => {}, spotifyClient: client, reccoClient: recco });

    expect(result.libraryPlaylists).toHaveLength(1);
    expect((await database.getPlaylist('lib')).trackList).toHaveLength(1);
});

test('the features phase emits start and complete', async () => {
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map([['t1', 'rb-1']])),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map([['t1', { tempo: 128 }]]))
    };
    const events = [];

    await runSync({ emit: (e) => events.push(e), spotifyClient: client, reccoClient: recco });

    expect(events.some(e => e.type === 'phase:start' && e.phase === 'features')).toBe(true);
    expect(events.some(e => e.type === 'phase:complete' && e.phase === 'features')).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/syncEngine`
Expected: FAIL — `result.featuresById` is undefined.

- [ ] **Step 3: Add the phase to `src/sync/syncEngine.js`**

Add the import:

```javascript
import * as reccobeats from '../reccobeats.js';
```

Add the phase function:

```javascript
// Fifth phase: tempo and other audio features from ReccoBeats, keyed by Spotify
// track id. Measured coverage of this library is ~68%; misses are recorded so they
// are never re-requested, and the gap is surfaced in the UI rather than hidden.
//
// Deliberately non-fatal: playlists are the product, tempo is an enhancement. A
// ReccoBeats outage must not cost the user their library.
async function runFeaturesPhase(playlists, { emit, reccoClient }) {
    const trackIds = new Set();
    for (const playlist of playlists) {
        for (const track of playlist.trackList ?? []) {
            if (track?.id) trackIds.add(track.id);
        }
    }

    const allIds = Array.from(trackIds);
    const missing = await database.getTrackIdsMissingAudioFeatures(allIds);

    const batches = [];
    for (let i = 0; i < missing.length; i += reccobeats.RECCOBEATS_BATCH_SIZE) {
        batches.push(missing.slice(i, i + reccobeats.RECCOBEATS_BATCH_SIZE));
    }

    emit({ type: 'phase:start', phase: 'features', total: batches.length, at: Date.now() });

    await mapWithConcurrency(batches, SYNC_CONCURRENCY, async (batch, index) => {
        const startedAt = Date.now();
        const onApiCall = (info) => emit({ type: 'api:call', phase: 'features', rateLimited: info.rateLimited });

        try {
            const idMap = await reccoClient.resolveTrackIds(batch, { onApiCall });

            const featuresBySpotifyId = idMap.size > 0
                ? await reccoClient.fetchAudioFeatures(Array.from(idMap.values()), { onApiCall })
                : new Map();

            const records = batch.map((trackId) => {
                const features = featuresBySpotifyId.get(trackId);
                // A miss is stored, not skipped. Skipping would re-request every
                // known-absent track on every future sync.
                return features
                    ? { id: trackId, ...features, source: 'reccobeats' }
                    : { id: trackId, source: 'reccobeats-notfound' };
            });

            await database.putTrackAudioFeaturesBatch(records);

            emit({
                type: 'item:success', phase: 'features',
                playlistId: `features-${index}`, name: `${batch.length} tracks`,
                trackCount: featuresBySpotifyId.size, durationMs: Date.now() - startedAt
            });
        } catch (error) {
            emit({
                type: 'item:error', phase: 'features',
                playlistId: `features-${index}`, name: `${batch.length} tracks`,
                cause: { kind: error.kind ?? 'http', status: error.status ?? 0 },
                storedTrackCount: 0, tracksTotal: batch.length
            });
        }
    });

    emit({ type: 'phase:complete', phase: 'features', at: Date.now() });

    return await database.getAudioFeaturesMap(allIds);
}
```

- [ ] **Step 4: Call it from `runSync`**

Change the signature to accept the client:

```javascript
async function runSync({ emit, spotifyClient = spotify, reccoClient = reccobeats }) {
```

Then, after the repair merge and sorts but **before** `emit({ type: 'sync:complete' })`:

```javascript
    // Non-fatal by construction: a features failure must never cost the user their
    // playlists, which are already safely stored by this point.
    let featuresById = new Map();
    try {
        featuresById = await runFeaturesPhase([...mergedLibrary, ...mergedClass], { emit, reccoClient });
    } catch (error) {
        console.warn('Track tempo phase failed; continuing without it', error);
        emit({ type: 'phase:complete', phase: 'features', at: Date.now() });
    }

    emit({ type: 'sync:complete', at: Date.now() });

    return { libraryPlaylists: mergedLibrary, classPlaylists: mergedClass, featuresById };
```

- [ ] **Step 5: Run the full suite and build**

Run: `CI=true bunx react-scripts test` then `CI=true bun run build`
Expected: all pass; "Compiled successfully", no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/sync/syncEngine.js src/sync/syncEngine.test.js
git commit -m "feat: fetch track tempo from ReccoBeats as a fifth sync phase"
```

---

### Task 5: Tempo in the track table

**Files:**
- Modify: `src/trackLibrary.js`, `src/trackLibrary.test.js`, `src/App.jsx`

**Interfaces:**
- Consumes: `featuresById` from `runSync`
- Produces: `buildTrackLibrary(libraryPlaylists, classPlaylists, now, featuresById)` — each row gains `tempo` (a number, or `null` when unknown)

- [ ] **Step 1: Write the failing tests**

```javascript
test('attaches tempo when the features map has it', () => {
    const features = new Map([['t1', { tempo: 128.4 }]]);
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])], [], NOW, features
    );

    expect(result[0].tempo).toBe(128.4);
});

test('tempo is null when the track has no features', () => {
    // ~32% of this library. Must be null, never 0 or undefined-by-omission,
    // so the UI can distinguish "no data" from "a real value".
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])], [], NOW, new Map()
    );

    expect(result[0].tempo).toBeNull();
});

test('works without a features map at all', () => {
    const result = buildTrackLibrary(
        [libraryPlaylist([track('t1', 'Alpha', daysAgo(10))])], [], NOW
    );

    expect(result[0].tempo).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=trackLibrary`
Expected: FAIL — `tempo` is undefined.

- [ ] **Step 3: Attach tempo in `src/trackLibrary.js`**

Change the signature and JSDoc to take a fourth argument `featuresById = new Map()`, and in the object pushed into `trackMap`, add:

```javascript
                // null, not undefined or 0 — the UI must be able to tell "no data"
                // apart from a real reading. Roughly a third of this library has none.
                tempo: featuresById.get(storedTrack.id)?.tempo ?? null,
```

- [ ] **Step 4: Add the Tempo column in `src/App.jsx`**

In the `matColumns` `useMemo`, add this column immediately after the Duration column:

```jsx
      {
        // Rows carry tempo: null, but TanStack's sortUndefined only recognises
        // `undefined` — returning null here would sort unknowns as a low value and
        // bury real slow tracks beneath them.
        accessorFn: (row) => row.tempo ?? undefined,
        id: "tempo",
        header: "BPM",
        size: 40,
        enableColumnFilter: false,
        sortUndefined: 'last',
        Cell: ({ cell }) => {
          const tempo = cell.getValue();
          return (
            <Box sx={{
              fontFamily: 'monospace',
              fontWeight: tempo ? 600 : 400,
              color: tempo ? '#1DB954' : 'rgba(255,255,255,0.3)'
            }}>
              {tempo ? Math.round(tempo) : '—'}
            </Box>
          );
        }
      },
```

Filtering is deliberately disabled on this column for now. A BPM range filter would silently exclude the ~32 % of tracks with no reading, which is the exact failure this project has spent two stages eliminating. Sorting is safe because `sortUndefined: 'last'` keeps unknowns visible at the end rather than interleaving them.

- [ ] **Step 5: Pass the features through in `src/App.jsx`**

In `getData`, destructure `featuresById` from `runSync` and pass it to `buildTrackLibrary`:

```javascript
      const { libraryPlaylists: _libraryPlaylists, classPlaylists: _classPlaylists, featuresById } = await runSync({ emit });

      setLibraryPlaylists(_libraryPlaylists);
      setClassPlaylists(_classPlaylists);
      setTrackLibrary(buildTrackLibrary(_libraryPlaylists, _classPlaylists, Date.now(), featuresById));
```

- [ ] **Step 6: Run the full suite and build**

Run: `CI=true bunx react-scripts test` then `CI=true bun run build`
Expected: all pass; "Compiled successfully", no warnings.

- [ ] **Step 7: Commit**

```bash
git add src/trackLibrary.js src/trackLibrary.test.js src/App.jsx
git commit -m "feat: show track BPM in the table, with unknowns rendered as em-dash"
```

---

### Task 6: Live verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-spotify-sync-observability-design.md`

- [ ] **Step 1: Cold run**

Delete the `playlist-planner` IndexedDB, load the app, let all five phases complete.

- [ ] **Step 2: Record**

| Measure | Expected | Actual |
| --- | --- | --- |
| Tracks with tempo | ~4,150 of 6,085 | |
| Tracks recorded `reccobeats-notfound` | ~1,930 | |
| ReccoBeats requests | ~305 | |
| Rate-limited calls | 0 | |
| Features phase wall clock | | |
| Playlists still complete | 573 / 573 | |

- [ ] **Step 3: Second run**

Reload. The features phase must make **zero** ReccoBeats requests — every track is either stored or recorded as a miss. If it makes any, the not-found marker is not working and the app will re-request ~1,930 tracks on every launch.

- [ ] **Step 4: Confirm the table**

BPM column populated for covered tracks, `—` for the rest. Sorting puts unknowns last.

- [ ] **Step 5: Append a `## Track tempo results` section to the spec and commit**
