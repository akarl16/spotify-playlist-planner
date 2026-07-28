# Spotify Sync Correctness — Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop provoking Spotify's rate limiter, survive it when it happens, and repair the 462 damaged playlists the Stage 1 baseline measured.

**Architecture:** A bounded worker pool replaces the unbounded `Promise.all` in `src/sync/syncEngine.js`; retry with `Retry-After` and jittered backoff lands inside the existing `spotifyFetch` chokepoint in `src/spotify.js`; the repair phase — already rendered and already reporting its queue — starts executing as the final phase of the same run. No new modules beyond the pool; Stage 1 was built so this is a contained change.

**Tech Stack:** React 18, Create React App (`react-scripts` 5), MUI 6, `idb` 8, Jest + jsdom, `fake-indexeddb`, bun.

Design spec (includes Stage 0 and Stage 1 measurements): [`../specs/2026-07-27-spotify-sync-observability-design.md`](../specs/2026-07-27-spotify-sync-observability-design.md)
Stage 1 plan: [`2026-07-27-sync-observability-stage-1.md`](2026-07-27-sync-observability-stage-1.md)

## What the baseline established

A cold sync of 631 playlists produced **462 failures out of 573 in-scope playlists**, and `byErrorKind` was `{ rate_limit: 462 }` — a single cause at 100%. Zero auth failures, zero network failures. **459 of the 462 failed on their very first request**, storing zero tracks. Roughly 610 requests were made and about 75% returned HTTP 429. Request latency was p50 425 ms / p95 643 ms.

Two consequences drive the ordering below:

1. **Bounded concurrency is the fix, not one of several improvements.** One cause accounts for every failure.
2. **Retry must not land before the pool.** Retrying 462 requests into an already-saturated rolling window extends the storm rather than clearing it.

## Global Constraints

- **Task order is load-bearing.** The pool lands and is measured *alone* before retry exists. If both land together and the 429 rate drops, we cannot attribute the improvement, and a retry storm can hide behind a pool that is still too wide.
- **Pool size is a fixed named constant, `SYNC_CONCURRENCY`, starting at `4`.** Not adaptive. Tuning means re-running and reading the 429 rate off the backdrop.
- **A partial result is still never recorded as `complete`.** Completeness means the pagination loop reached `next === null` with zero errors, after retries are exhausted. Never compare stored count to `tracks.total`.
- **Emptiness is never a skip signal.** `[]` is truthy. Checks test `.length`.
- Retry is capped. An exhausted retry records `incomplete`/`failed` with its cause — it must never fall through into looking like success.
- The backdrop still **blocks** the app. Non-blocking sync remains out of scope.
- Do not touch `src/getsongbpm.js`, `api/getsongbpm/`, `getTracksNeedingBpmAnalysis`, or `getStorageStats`. Dead but deliberately out of scope.
- IndexedDB stays at **version 3**. No schema change in this stage.
- Package manager is **bun**. Tests run one-shot with `CI=true`.
- Commit after every task.

## Already fixed in Stage 1 — do not re-plan

These appeared on the original Stage 2 list and are already done: `tx.done` awaited on playlist writes, the `[]`-is-truthy skip bug, `sort((a,b) => a.name - b.name)` (the engine uses `localeCompare`), and `buildTrackLibrary` mutating its inputs.

---

### Task 1: Bounded worker pool

The single highest-impact change. Lands and is measured alone.

**Files:**
- Create: `src/sync/pool.js`
- Test: `src/sync/pool.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `mapWithConcurrency(items, limit, worker) => Promise<Array>` — resolves to results in the same order as `items`. `worker` is `(item, index) => Promise<any>`. A worker that rejects propagates its rejection (matching `Promise.all`), but must not stall or deadlock the remaining queue.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/sync/pool.test.js
import { mapWithConcurrency } from './pool.js';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

test('resolves results in input order regardless of completion order', async () => {
    const items = [30, 10, 20];
    const result = await mapWithConcurrency(items, 3, async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
    });

    expect(result).toEqual([30, 10, 20]);
});

test('never runs more than `limit` workers at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
    });

    expect(peak).toBe(4);
});

test('starts a queued item as soon as a slot frees, not in fixed batches', async () => {
    // Batching would leave 3 slots idle while the slow item runs.
    const gates = [deferred(), deferred(), deferred()];
    const started = [];
    const items = [0, 1, 2, 3, 4];

    const run = mapWithConcurrency(items, 2, async (i) => {
        started.push(i);
        if (i < 3) await gates[i].promise;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    gates[0].resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    await run;
    expect(started).toEqual([0, 1, 2, 3, 4]);
});

test('a rejecting worker does not stall the remaining queue', async () => {
    const completed = [];
    const items = [0, 1, 2, 3, 4, 5];

    await expect(mapWithConcurrency(items, 2, async (i) => {
        if (i === 1) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 1));
        completed.push(i);
    })).rejects.toThrow('boom');

    // Give any orphaned workers a chance to settle before asserting.
    await new Promise((r) => setTimeout(r, 20));
    expect(completed).not.toHaveLength(0);
});

test('an empty input resolves to an empty array without invoking the worker', async () => {
    const worker = jest.fn();

    await expect(mapWithConcurrency([], 4, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
});

test('a limit larger than the input runs everything without error', async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (n) => n * 2);

    expect(result).toEqual([2, 4]);
});

test('passes the index to the worker', async () => {
    const seen = [];

    await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, index) => { seen.push([item, index]); });

    expect(seen.sort()).toEqual([['a', 0], ['b', 1], ['c', 2]]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/pool`
Expected: FAIL — cannot resolve `./pool.js`.

- [ ] **Step 3: Implement `src/sync/pool.js`**

```javascript
/**
 * Runs `worker` over `items` with at most `limit` in flight at once.
 *
 * Results come back in input order. A rejecting worker propagates its rejection,
 * matching Promise.all — but unlike a batching implementation, a slow item never
 * holds idle slots: each runner pulls the next index the moment it frees up.
 *
 * This replaces an unbounded Promise.all that fanned out over 573 playlists at
 * once and had roughly 75% of its requests rejected with HTTP 429.
 */
async function mapWithConcurrency(items, limit, worker) {
    if (items.length === 0) return [];

    const results = new Array(items.length);
    const width = Math.max(1, Math.min(limit, items.length));
    let nextIndex = 0;

    async function runner() {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: width }, () => runner()));
    return results;
}

export { mapWithConcurrency };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/pool`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire the pool into the engine**

In `src/sync/syncEngine.js`, add the import and the constant near the existing `PAGE_SIZE`:

```javascript
import { mapWithConcurrency } from './pool.js';

// Tuned against the measured 429 rate. The Stage 1 baseline fanned out over all
// 573 playlists at once and had ~75% of its requests rejected. Raise this only
// while the backdrop's rate-limited count stays at or near zero.
const SYNC_CONCURRENCY = 4;
```

Then replace the unbounded fan-out inside `syncPlaylistBatch`:

```javascript
    const playlists = await Promise.all(
        headers.map((header) => syncOnePlaylist(header, phase, { emit, spotifyClient }))
    );
```

with:

```javascript
    const playlists = await mapWithConcurrency(
        headers,
        SYNC_CONCURRENCY,
        (header) => syncOnePlaylist(header, phase, { emit, spotifyClient })
    );
```

- [ ] **Step 6: Update the engine test that asserted unbounded fan-out**

`src/sync/syncEngine.test.js` contains a test named `'STAGE 1: does not retry after a 429 — one attempt per playlist'`. It stays valid — retry does not exist yet. Do not change it.

Add this test, which pins the pool being used:

```javascript
test('playlist fetching is bounded by the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const playlists = Array.from({ length: 20 }, (_, i) => header(`p${i}`, `2026-01-${String(i + 1).padStart(2, '0')} Ride`, 1));
    const itemsByPlaylist = Object.fromEntries(playlists.map(p => [p.id, [makeItem('t1')]]));

    const client = makeClient({ playlists, itemsByPlaylist });
    const original = client.getPlaylistItems;
    client.getPlaylistItems = async (...args) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
            await new Promise((r) => setTimeout(r, 2));
            return await original(...args);
        } finally {
            inFlight--;
        }
    };

    await runSync({ emit: () => {}, spotifyClient: client });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
});
```

- [ ] **Step 7: Run the full suite and build**

Run: `CI=true bunx react-scripts test`
Expected: PASS, all suites.

Run: `CI=true bun run build`
Expected: "Compiled successfully", no warnings.

- [ ] **Step 8: Commit**

```bash
git add src/sync/pool.js src/sync/pool.test.js src/sync/syncEngine.js src/sync/syncEngine.test.js
git commit -m "feat: bound sync concurrency with a worker pool"
```

---

### Task 2: Measure the pool alone

The whole reason retry is not in Task 1. This is a measurement task, not a code task — the controller runs it.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-spotify-sync-observability-design.md`

**Interfaces:**
- Consumes: Task 1
- Produces: a recorded 429 rate attributable to bounded concurrency alone, which sets the retry policy's expectations and confirms or corrects the pool size

- [ ] **Step 1: Run a cold sync**

Delete the `playlist-planner` IndexedDB from devtools → Application → IndexedDB, then load the app and let it complete. Expand the backdrop before it finishes to read the live stats.

- [ ] **Step 2: Record against the baseline**

| Measure | Baseline (unbounded) | Pool = 4 |
| --- | --- | --- |
| Playlists complete | 111 | |
| Playlists failed | 459 | |
| Playlists incomplete | 3 | |
| Rate-limited calls | ~462 of ~610 (75%) | |
| Wall clock | ~30 s | |

- [ ] **Step 3: Decide the pool size**

If the rate-limited count is at or near zero, keep 4 and note the headroom. If it is still material, halve to 2 and re-run before writing any retry code — a pool that still provokes 429s makes retry actively harmful.

- [ ] **Step 4: Append a `## Stage 2 — pool-only measurement` section to the spec and commit**

```bash
git add docs/superpowers/specs/2026-07-27-spotify-sync-observability-design.md
git commit -m "docs: record 429 rate with bounded concurrency and no retry"
```

---

### Task 3: Retry with `Retry-After` and jittered backoff

Only after Task 2 shows the pool is not itself provoking 429s.

**Files:**
- Modify: `src/spotify.js`
- Test: `src/spotify.test.js`

**Interfaces:**
- Consumes: `SpotifyApiError` with `.status`, `.retryAfter`, `.kind` (already exists)
- Produces: `spotifyFetch(path, { method, body, onApiCall, maxAttempts, sleep })` — retries internally and throws the final `SpotifyApiError` when attempts are exhausted. `sleep` defaults to a real timer and is injected in tests. Exports `RETRY_MAX_ATTEMPTS` and `computeBackoffMs(attempt, retryAfterSeconds, random)`.

- [ ] **Step 1: Isolate `localStorage` between tests**

`src/setupTests.js` resets IndexedDB per test but NOT `localStorage`, and the tests
below (and in Task 4) write `refresh_token` / `access_token`. Without this they leak
into each other and pass or fail depending on order. Add to the existing `beforeEach`
in `src/spotify.test.js`:

```javascript
beforeEach(() => {
    localStorage.clear();
    __setAccessTokenForTests(undefined);
});
```

Keep the existing `beforeEach` body (setting the token and stubbing `global.fetch`) —
add these two lines to it rather than replacing it. Tests that need a token set it
explicitly.

- [ ] **Step 2: Write the failing tests**

```javascript
// add to src/spotify.test.js — keep every existing test
import { computeBackoffMs, RETRY_MAX_ATTEMPTS } from './spotify.js';

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=spotify`
Expected: FAIL — `computeBackoffMs is not exported`.

- [ ] **Step 4: Add the retry policy to `src/spotify.js`**

Insert above `spotifyFetch`:

```javascript
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const RETRY_JITTER_FRACTION = 0.5;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Spotify's Retry-After is authoritative when present. Otherwise back off
// exponentially with jitter — without jitter, every worker that was rejected in the
// same window wakes at the same instant and recreates the burst that caused it.
function computeBackoffMs(attempt, retryAfterSeconds, random = Math.random) {
    if (retryAfterSeconds !== null && retryAfterSeconds !== undefined) {
        return Math.round(retryAfterSeconds * 1000);
    }
    const base = RETRY_BASE_MS * Math.pow(2, attempt - 1);
    return Math.round(base * (1 + RETRY_JITTER_FRACTION * random()));
}

function isRetryable(error) {
    return error.kind === 'rate_limit' || error.kind === 'network' || error.status >= 500;
}
```

- [ ] **Step 5: Wrap `spotifyFetch`'s body in the retry loop**

Rename the existing `spotifyFetch` implementation to `spotifyFetchOnce`. Keep its body
exactly as it is — the token guard, the `onApiCall` reporting on all three outcomes,
the `SpotifyApiError` construction, and the 204 handling — with exactly one change:
replace the bare `return await response.json();` with the guarded version below, so a
malformed 200 body surfaces as a typed error instead of a raw `SyntaxError`.

```javascript
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
```

Then add the retrying wrapper:

```javascript
async function spotifyFetch(path, { method = 'GET', body = null, onApiCall = null, maxAttempts = RETRY_MAX_ATTEMPTS, sleep = defaultSleep } = {}) {
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
```

- [ ] **Step 6: Update the export list**

Add `computeBackoffMs` and `RETRY_MAX_ATTEMPTS` to the existing export block in `src/spotify.js`.

- [ ] **Step 7: Fix the Stage 1 engine test that asserted no retry**

`src/sync/syncEngine.test.js`'s `'STAGE 1: does not retry after a 429 — one attempt per playlist'` is now wrong: the engine's injected fake client throws directly, so the engine itself still does not retry, but the test's name is misleading. Rename it to `'the engine itself does not retry — retry lives in spotifyFetch'` and add a comment explaining that retry is the transport's job, so the engine sees only the final outcome. Do not change its assertions.

- [ ] **Step 8: Run the full suite and build**

Run: `CI=true bunx react-scripts test`
Expected: PASS, all suites.

Run: `CI=true bun run build`
Expected: "Compiled successfully", no warnings.

- [ ] **Step 9: Commit**

```bash
git add src/spotify.js src/spotify.test.js src/sync/syncEngine.test.js
git commit -m "feat: retry rate-limited and transient Spotify failures with jittered backoff"
```

---

### Task 4: Refresh the access token on 401 and ahead of expiry

No auth failure occurred in the ~30 s baseline. It becomes reachable precisely *because* bounded concurrency stretches a sync toward the one-hour token lifetime — a risk this stage creates.

**Files:**
- Modify: `src/spotify.js`
- Test: `src/spotify.test.js`

**Interfaces:**
- Consumes: existing `retrieveAccessTokenFromRefresh`, `getWithExpiry`, `setWithExpiry`
- Produces: `getValidAccessToken() => Promise<string|null>` — returns a token that is not within the expiry margin, refreshing if needed. `spotifyFetchOnce` awaits it instead of reading the module variable.

- [ ] **Step 1: Write the failing tests**

```javascript
// add to src/spotify.test.js
import { getValidAccessToken, TOKEN_EXPIRY_MARGIN_MS } from './spotify.js';

test('a 401 refreshes the token once and retries the request', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    __setAccessTokenForTests('stale-token');
    localStorage.setItem('refresh_token', 'refresh-abc');

    global.fetch
        .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse({ access_token: 'fresh-token', expires_in: 3600, refresh_token: 'refresh-abc' }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(spotifyFetch('/me/playlists', { sleep })).resolves.toEqual({ ok: true });

    const authHeaders = global.fetch.mock.calls
        .map(([, init]) => init?.headers?.Authorization)
        .filter(Boolean);
    expect(authHeaders[authHeaders.length - 1]).toBe('Bearer fresh-token');
});

test('a 401 that cannot be refreshed fails without an infinite loop', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    __setAccessTokenForTests('stale-token');
    localStorage.removeItem('refresh_token');

    global.fetch.mockResolvedValue(jsonResponse({}, { status: 401 }));

    await expect(spotifyFetch('/me/playlists', { sleep })).rejects.toMatchObject({ status: 401, kind: 'auth' });
    // One original attempt plus at most one refresh-and-retry.
    expect(global.fetch.mock.calls.length).toBeLessThanOrEqual(2);
});

test('a token inside the expiry margin is refreshed before the request goes out', async () => {
    localStorage.setItem('refresh_token', 'refresh-abc');
    localStorage.setItem('access_token', JSON.stringify({
        value: 'about-to-expire',
        expiry: Date.now() + TOKEN_EXPIRY_MARGIN_MS - 1000
    }));

    global.fetch.mockResolvedValueOnce(jsonResponse({ access_token: 'fresh-token', expires_in: 3600, refresh_token: 'refresh-abc' }));

    await expect(getValidAccessToken()).resolves.toBe('fresh-token');
});

test('a token comfortably inside its lifetime is reused without a refresh call', async () => {
    localStorage.setItem('access_token', JSON.stringify({
        value: 'still-good',
        expiry: Date.now() + 30 * 60 * 1000
    }));

    await expect(getValidAccessToken()).resolves.toBe('still-good');
    expect(global.fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=spotify`
Expected: FAIL — `getValidAccessToken is not exported`.

- [ ] **Step 3: Add the refreshing accessor to `src/spotify.js`**

```javascript
// Refresh this far ahead of expiry. A bounded-concurrency sync of 573 playlists
// runs for minutes, so a token that is merely "not expired yet" when the sync
// starts can expire midway through it.
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// Collapses concurrent refreshes: with a worker pool, several in-flight requests
// can discover an expiring token in the same tick, and each firing its own refresh
// would race and discard tokens.
let inFlightRefresh = null;

async function getValidAccessToken() {
    const stored = localStorage.getItem('access_token');

    if (stored) {
        const item = JSON.parse(stored);
        if (item.expiry - Date.now() > TOKEN_EXPIRY_MARGIN_MS) {
            access_token = item.value;
            spotifyApi.setAccessToken(access_token);
            return access_token;
        }
    }

    const refreshToken = localStorage.getItem('refresh_token');
    if (!refreshToken) return null;

    if (!inFlightRefresh) {
        inFlightRefresh = retrieveAccessTokenFromRefresh(refreshToken)
            .finally(() => { inFlightRefresh = null; });
    }

    const refreshed = await inFlightRefresh;
    if (refreshed) {
        access_token = refreshed;
        spotifyApi.setAccessToken(access_token);
    }
    return refreshed;
}
```

- [ ] **Step 4: Use it in `spotifyFetchOnce` and retry once on 401**

In `spotifyFetchOnce`, replace `const token = getAccessToken();` with `const token = await getValidAccessToken();`, keeping the existing null-token guard.

In `spotifyFetch`'s catch block, add a single 401 recovery before the retryable check:

```javascript
        } catch (err) {
            lastError = err;

            // One refresh-and-retry for a 401. `refreshedForAuth` prevents an
            // infinite loop when the refresh token itself is dead.
            if (err.status === 401 && !refreshedForAuth) {
                refreshedForAuth = true;
                const refreshed = await getValidAccessToken();
                if (refreshed) continue;
            }

            if (!isRetryable(err) || attempt === maxAttempts) throw err;
            await sleep(computeBackoffMs(attempt, err.retryAfter));
        }
```

Declare `let refreshedForAuth = false;` alongside `let lastError;`.

- [ ] **Step 5: Export `getValidAccessToken` and `TOKEN_EXPIRY_MARGIN_MS`**

- [ ] **Step 6: Run the full suite and build**

Run: `CI=true bunx react-scripts test` then `CI=true bun run build`
Expected: all pass; "Compiled successfully" with no warnings.

- [ ] **Step 7: Commit**

```bash
git add src/spotify.js src/spotify.test.js
git commit -m "feat: refresh the access token ahead of expiry and once on 401"
```

---

### Task 5: Execute the repair phase

The phase already renders and already reports its queue. This makes it do work — and fixes the snapshot trap the whole-branch review flagged.

**Files:**
- Modify: `src/sync/syncEngine.js`
- Test: `src/sync/syncEngine.test.js`

**Interfaces:**
- Consumes: `getPlaylistIdsNeedingRepair`, `mapWithConcurrency`, `syncOnePlaylist`
- Produces: `runSync` returns `{ libraryPlaylists, classPlaylists }` reflecting **post-repair** data

- [ ] **Step 1: Write the failing tests**

```javascript
test('the repair phase re-fetches a playlist left empty by an earlier failure', async () => {
    await database.setPlaylist({ ...header('cls', '2026-07-25 Ride', 1), trackList: [] });
    await database.putSyncState({
        playlistId: 'cls', snapshotId: 's1', status: 'failed',
        fetchedItemCount: 0, storedTrackCount: 0, tracksTotal: 1,
        lastAttemptAt: 1, lastSuccessAt: null, attempts: 1,
        lastError: { kind: 'rate_limit', status: 429, message: '429' }
    });

    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { cls: [makeItem('t1')] }
    });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getPlaylist('cls')).trackList).toHaveLength(1);
    expect((await database.getSyncState('cls')).status).toBe(SYNC_STATUS.COMPLETE);
});

test('repaired playlists are reflected in the returned data, not just in storage', async () => {
    // The snapshot trap: runSync used to build its return value before repair ran,
    // so the UI showed pre-repair data until the next reload.
    await database.setPlaylist({ ...header('cls', '2026-07-25 Ride', 1), trackList: [] });
    await database.putSyncState({
        playlistId: 'cls', snapshotId: 's1', status: 'failed',
        fetchedItemCount: 0, storedTrackCount: 0, tracksTotal: 1,
        lastAttemptAt: 1, lastSuccessAt: null, attempts: 1,
        lastError: { kind: 'rate_limit', status: 429, message: '429' }
    });

    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { cls: [makeItem('t1')] }
    });

    const result = await runSync({ emit: () => {}, spotifyClient: client });

    const repaired = result.classPlaylists.find(p => p.id === 'cls');
    expect(repaired.trackList).toHaveLength(1);
});

test('the repair phase emits start, item and complete events', async () => {
    await database.setPlaylist({ ...header('cls', '2026-07-25 Ride', 1), trackList: [] });
    await database.putSyncState({
        playlistId: 'cls', snapshotId: 's1', status: 'failed',
        fetchedItemCount: 0, storedTrackCount: 0, tracksTotal: 1,
        lastAttemptAt: 1, lastSuccessAt: null, attempts: 1, lastError: null
    });

    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { cls: [makeItem('t1')] }
    });
    const events = [];

    await runSync({ emit: (e) => events.push(e), spotifyClient: client });

    expect(events.some(e => e.type === 'phase:start' && e.phase === 'repair')).toBe(true);
    expect(events.some(e => e.type === 'item:success' && e.phase === 'repair')).toBe(true);
    expect(events.some(e => e.type === 'phase:complete' && e.phase === 'repair')).toBe(true);
});

test('a playlist already complete at the current snapshot is not repaired', async () => {
    const client = makeClient({
        playlists: [header('cls', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { cls: [makeItem('t1')] }
    });

    await runSync({ emit: () => {}, spotifyClient: client });
    const spy = jest.spyOn(client, 'getPlaylistItems');
    await runSync({ emit: () => {}, spotifyClient: client });

    expect(spy).not.toHaveBeenCalled();
});

test('repair forces a re-fetch even though the playlist already holds partial data', async () => {
    // The skip predicate must not veto repair — the partial data is the problem.
    const items = Array.from({ length: 120 }, (_, i) => makeItem(`t${i}`));
    await database.setPlaylist({
        ...header('lib', '[LIBRARY] Main', 120),
        trackList: items.slice(0, 50).map(e => ({ id: e.item.id, added_at: new Date(), name: e.item.name, artists: [], duration_ms: 1 }))
    });
    await database.putSyncState({
        playlistId: 'lib', snapshotId: 's1', status: 'incomplete',
        fetchedItemCount: 50, storedTrackCount: 50, tracksTotal: 120,
        lastAttemptAt: 1, lastSuccessAt: null, attempts: 1,
        lastError: { kind: 'rate_limit', status: 429, message: '429' }
    });

    const client = makeClient({ playlists: [header('lib', '[LIBRARY] Main', 120)], itemsByPlaylist: { lib: items } });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect((await database.getPlaylist('lib')).trackList).toHaveLength(120);
    expect((await database.getSyncState('lib')).status).toBe(SYNC_STATUS.COMPLETE);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/syncEngine`
Expected: FAIL — repair does not execute.

- [ ] **Step 3: Give `syncOnePlaylist` a force flag**

The skip predicate must not veto repair. Change its signature and the guard:

```javascript
async function syncOnePlaylist(header, phase, { emit, spotifyClient, force = false }) {
    const existing = await database.getPlaylist(header.id);

    // `.length`, NOT truthiness. An empty array means a previous run failed on the
    // first page; the old code treated [] as "already have it" and skipped these
    // forever, which is how 440 playlists ended up permanently empty.
    //
    // `force` is how repair overrides this: a playlist under repair already holds
    // partial data, and that partial data is precisely what we are replacing.
    if (!force && existing?.trackList?.length) {
```

Everything else in the function is unchanged.

- [ ] **Step 4: Replace `reportRepairQueue` with an executing phase**

```javascript
// Re-fetches everything not known-good: incomplete, failed, never verified, or
// sitting at a stale snapshot. After the v3 migration that is the whole library,
// which is deliberate — a damaged playlist is indistinguishable from a healthy one
// from the inside, so none of the pre-existing cache is trusted.
async function runRepairPhase(inScopeHeaders, { emit, spotifyClient }) {
    const headersById = Object.fromEntries(inScopeHeaders.map((header) => [header.id, header]));
    const needingRepair = await getPlaylistIdsNeedingRepair(headersById);
    const headers = needingRepair.map((id) => headersById[id]).filter(Boolean);

    emit({ type: 'phase:start', phase: 'repair', total: headers.length, at: Date.now() });

    const repaired = await mapWithConcurrency(
        headers,
        SYNC_CONCURRENCY,
        (header) => syncOnePlaylist(header, 'repair', { emit, spotifyClient, force: true })
    );

    emit({ type: 'phase:complete', phase: 'repair', at: Date.now() });

    return new Map(repaired.map((playlist) => [playlist.id, playlist]));
}
```

- [ ] **Step 5: Fix the snapshot trap in `runSync`**

Repair must run *before* the return value is assembled. Replace the tail of `runSync`:

```javascript
    const libraryPlaylists = await syncPlaylistBatch(libraryHeaders, 'library', { emit, spotifyClient });
    const classPlaylists = await syncPlaylistBatch(classHeaders, 'class', { emit, spotifyClient });

    const repaired = await runRepairPhase([...libraryHeaders, ...classHeaders], { emit, spotifyClient });

    // Fold repaired records back in, or the UI would render pre-repair data until
    // the next reload.
    const merge = (playlists) => playlists.map((playlist) => repaired.get(playlist.id) ?? playlist);

    const mergedLibrary = merge(libraryPlaylists);
    const mergedClass = merge(classPlaylists);

    mergedLibrary.sort((a, b) => a.name.localeCompare(b.name));
    mergedClass.sort((a, b) => b.name.localeCompare(a.name));

    emit({ type: 'sync:complete', at: Date.now() });

    return { libraryPlaylists: mergedLibrary, classPlaylists: mergedClass };
```

Remove the two `.sort(...)` calls that previously ran immediately after each `syncPlaylistBatch`, since sorting now happens after the merge.

- [ ] **Step 6: Run the full suite and build**

Run: `CI=true bunx react-scripts test` then `CI=true bun run build`
Expected: all pass; "Compiled successfully", no warnings.

- [ ] **Step 7: Commit**

```bash
git add src/sync/syncEngine.js src/sync/syncEngine.test.js
git commit -m "feat: execute the repair phase and fold repaired playlists into the result"
```

---

### Task 6: Refresh headers on a staleness window, and prune deleted playlists

**Files:**
- Modify: `src/sync/syncEngine.js`, `src/database.js`
- Test: `src/sync/syncEngine.test.js`

**Interfaces:**
- Consumes: `database.deletePlaylists` (already exists, currently unused)
- Produces: `HEADER_STALENESS_MS`; headers refetched when the stored set is older than that; playlists absent from Spotify's response removed along with their sync state

- [ ] **Step 1: Write the failing tests**

```javascript
test('headers are re-fetched when the stored set is stale', async () => {
    await database.setPlaylists([header('old', '2026-01-01 Ride', 1)]);
    localStorage.setItem('headers_synced_at', String(Date.now() - 25 * 60 * 60 * 1000));

    const client = makeClient({
        playlists: [header('old', '2026-01-01 Ride', 1), header('new', '2026-07-25 Ride', 1)],
        itemsByPlaylist: { old: [makeItem('t1')], new: [makeItem('t2')] }
    });
    const spy = jest.spyOn(client, 'getUserPlaylistsPage');

    await runSync({ emit: () => {}, spotifyClient: client });

    expect(spy).toHaveBeenCalled();
    expect(await database.getPlaylist('new')).toBeDefined();
});

test('headers are not re-fetched while the stored set is fresh', async () => {
    await database.setPlaylists([header('old', '2026-01-01 Ride', 1)]);
    localStorage.setItem('headers_synced_at', String(Date.now()));

    const client = makeClient({ playlists: [header('old', '2026-01-01 Ride', 1)], itemsByPlaylist: { old: [makeItem('t1')] } });
    const spy = jest.spyOn(client, 'getUserPlaylistsPage');

    await runSync({ emit: () => {}, spotifyClient: client });

    expect(spy).not.toHaveBeenCalled();
});

test('a playlist deleted from Spotify is pruned along with its sync state', async () => {
    await database.setPlaylists([header('gone', '2026-01-01 Ride', 1), header('kept', '2026-07-25 Ride', 1)]);
    await database.putSyncState({ playlistId: 'gone', status: 'complete', snapshotId: 's1' });
    localStorage.removeItem('headers_synced_at');

    const client = makeClient({ playlists: [header('kept', '2026-07-25 Ride', 1)], itemsByPlaylist: { kept: [makeItem('t1')] } });

    await runSync({ emit: () => {}, spotifyClient: client });

    expect(await database.getPlaylist('gone')).toBeUndefined();
    expect(await database.getSyncState('gone')).toBeUndefined();
    expect(await database.getPlaylist('kept')).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=sync/syncEngine`
Expected: FAIL — headers are only fetched when the store is empty.

- [ ] **Step 3: Replace the emptiness check with a staleness window**

In `src/sync/syncEngine.js`:

```javascript
// Playlists created in Spotify never appeared until the local store was emptied.
const HEADER_STALENESS_MS = 24 * 60 * 60 * 1000;
const HEADERS_SYNCED_AT_KEY = 'headers_synced_at';

function headersAreFresh(storedCount) {
    if (storedCount === 0) return false;
    const syncedAt = Number(localStorage.getItem(HEADERS_SYNCED_AT_KEY));
    if (!Number.isFinite(syncedAt) || syncedAt === 0) return false;
    return Date.now() - syncedAt < HEADER_STALENESS_MS;
}
```

Replace `if (stored.length > 0) {` in `syncPlaylistHeaders` with `if (headersAreFresh(stored.length)) {`.

- [ ] **Step 4: Prune and stamp after a successful header fetch**

After `await database.setPlaylists(headers);` in `syncPlaylistHeaders`:

```javascript
    // Playlists that no longer exist upstream. Pruning here rather than lazily keeps
    // the repair queue honest — a deleted playlist can never be repaired.
    const liveIds = new Set(headers.map((header) => header.id));
    const staleIds = (await database.getPlaylists())
        .map((playlist) => playlist.id)
        .filter((id) => !liveIds.has(id));

    if (staleIds.length > 0) {
        await database.deletePlaylists(staleIds);
    }

    localStorage.setItem(HEADERS_SYNCED_AT_KEY, String(Date.now()));
```

- [ ] **Step 5: Run the full suite and build**

Run: `CI=true bunx react-scripts test` then `CI=true bun run build`
Expected: all pass; "Compiled successfully", no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/sync/syncEngine.js src/sync/syncEngine.test.js
git commit -m "feat: refresh headers on a staleness window and prune deleted playlists"
```

---

### Task 7: Verification run against the baseline

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-spotify-sync-observability-design.md`

**Interfaces:**
- Consumes: Tasks 1-6
- Produces: the measurement that decides whether this work is done

- [ ] **Step 1: Cold run**

Delete the `playlist-planner` IndexedDB, load the app, let it complete.

- [ ] **Step 2: Second run immediately after**

Reload without clearing. This exercises the cache-hit path and confirms repair converges rather than re-fetching forever.

- [ ] **Step 3: Record the comparison**

| Measure | Stage 1 baseline | Stage 2 run 1 | Stage 2 run 2 |
| --- | --- | --- | --- |
| Playlists complete | 111 | | |
| Playlists failed | 459 | | |
| Playlists incomplete | 3 | | |
| Rate-limited calls | ~462 (75%) | | |
| Tracks cached | 7,065 | | |
| Wall clock | ~30 s | | |

- [ ] **Step 4: Judge against the success criterion**

Stage 2 succeeds when **the `incomplete` and `failed` counts reach zero across two consecutive runs** and the rate-limited count is near zero. Cycle Tempo should hold ~3,390 tracks rather than 500.

If failures remain, halve `SYNC_CONCURRENCY` and repeat before adding any further mechanism.

- [ ] **Step 5: Append a `## Stage 2 results` section to the spec and commit**

```bash
git add docs/superpowers/specs/2026-07-27-spotify-sync-observability-design.md
git commit -m "docs: record stage 2 results against the baseline"
```

---

## Deferred, with reasons

- **`__setAccessTokenForTests` ships in the production bundle** and mutates live auth state. Nothing calls it outside tests. Worth gating behind `NODE_ENV` once Task 4 settles the token accessor's shape.
- **Feed React keys change on every prepend**, causing remount churn. Cosmetic.
- **`telemetry` ignores events arriving before `sync:start`.** Relies on the engine's ordering contract, which holds.
