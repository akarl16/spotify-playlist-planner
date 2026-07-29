# Background Tempo Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ReccoBeats tempo fetching out of the blocking sync and into a background task that fills the BPM column in as it arrives, with a progress chip in the app bar.

**Architecture:** The features phase moves out of `runSync` into `src/sync/featuresLoader.js`, a cancellable loader that reports progress per batch. `runSync` returns only *cached* features (one IndexedDB read, no network) so already-known tempos render immediately. `App.jsx` starts the loader after sync completes, accumulates arriving features in a ref, and flushes them into the table on a timer.

**Tech Stack:** React 18, Create React App (`react-scripts` 5), MUI 6, `idb` 8, Jest + jsdom, `fake-indexeddb`, bun.

Design spec: [`../specs/2026-07-27-spotify-sync-observability-design.md`](../specs/2026-07-27-spotify-sync-observability-design.md)
Preceding plan: [`2026-07-29-track-tempo-via-reccobeats.md`](2026-07-29-track-tempo-via-reccobeats.md)

## Why

Tempo currently runs as a fifth phase inside the blocking backdrop. Measured, a full
tempo load is 179 batches at roughly 720 ms each — about **two minutes added to a
blocking wait**, for data that is an enhancement rather than the product. The
playlists are already complete and correct by the time it starts.

## Global Constraints

- **The blocking backdrop loses the `features` phase entirely.** It must be removed
  from `PHASES`, not left rendering. A phase row that never runs is the exact trap
  that Stage 1's non-executing repair row created, and it took a live run to notice.
- **`runSync` performs no tempo network I/O.** It returns `featuresById` read straight
  from IndexedDB so cached tempos appear the moment the table renders.
- **The loader is cancellable, and cancellation is checked between batches.** A
  refresh or unmount mid-load must stop it — otherwise a second load stacks on the
  first and both write to the same store.
- **Table updates are flushed on a timer, not per batch.** 179 rebuilds of a
  7,135-row virtualised grid would visibly jank while the user is scrolling.
- **Throttling is preserved exactly**: `FEATURES_CONCURRENCY` of 1 with a 120 ms
  inter-batch gap. Measured — at concurrency 2 with no delay, 59 of 179 batches
  returned HTTP 429; with this throttle, zero.
- **A miss is still recorded** as `source: 'reccobeats-notfound'`, or ~2,199
  known-absent tracks get re-requested on every launch forever.
- **Failure is visible, not silent.** If batches fail, the chip must end in a warning
  state rather than quietly vanishing. Failed batches are not poisoned, so they retry
  on the next launch — but the user should know the column is still incomplete.
- **The chip disappears on clean completion.** No permanent chrome for a finished job.
- `SYNC_CONCURRENCY` stays 2. Not to be touched.
- IndexedDB stays at **version 3**.
- Package manager is **bun**; tests run one-shot with `CI=true`.
- Commit after every task.

---

### Task 1: Extract a cancellable background loader

**Files:**
- Create: `src/sync/featuresLoader.js`
- Test: `src/sync/featuresLoader.test.js`
- Modify: `src/sync/syncEngine.js`, `src/sync/syncEngine.test.js`, `src/sync/telemetry.js`, `src/sync/telemetry.test.js`

**Interfaces:**
- Consumes: `reccobeats.resolveTrackIds`, `reccobeats.fetchAudioFeatures`, `database.getTrackIdsMissingAudioFeatures`, `database.putTrackAudioFeaturesBatch`
- Produces:
  - `loadTrackFeatures({ trackIds, reccoClient, sleep, onProgress, isCancelled }) => Promise<{ completed, batchesDone, batchesTotal, failedBatches, added }>`
  - `onProgress({ batchesDone, batchesTotal, failedBatches, features })` — `features` is a `Map<spotifyId, featureRecord>` containing **only this batch's** results
  - `isCancelled()` — checked before each batch; when it returns true the loader stops and resolves with `completed: false`
- `runSync` loses its features phase and its `reccoClient` parameter; it returns `featuresById` read from IndexedDB with no network I/O

- [ ] **Step 1: Write the failing tests**

```javascript
// src/sync/featuresLoader.test.js
import * as database from '../database.js';
import { loadTrackFeatures } from './featuresLoader.js';

beforeEach(async () => {
    await database.init();
});

const noSleep = () => Promise.resolve();

test('fetches features for the given tracks and stores them', async () => {
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map([['t1', 'rb-1']])),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map([['t1', { tempo: 128 }]]))
    };

    const result = await loadTrackFeatures({ trackIds: ['t1'], reccoClient: recco, sleep: noSleep });

    expect(result.completed).toBe(true);
    expect(await database.getTrackAudioFeatures('t1')).toMatchObject({ tempo: 128, source: 'reccobeats' });
});

test('records a catalogue miss so it is never re-requested', async () => {
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map()),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };

    await loadTrackFeatures({ trackIds: ['t1'], reccoClient: recco, sleep: noSleep });

    expect(await database.getTrackAudioFeatures('t1')).toMatchObject({ source: 'reccobeats-notfound' });
});

test('skips tracks that already have a record', async () => {
    await database.putTrackAudioFeaturesBatch([{ id: 't1', tempo: 128, source: 'reccobeats' }]);
    const recco = { resolveTrackIds: jest.fn(), fetchAudioFeatures: jest.fn() };

    const result = await loadTrackFeatures({ trackIds: ['t1'], reccoClient: recco, sleep: noSleep });

    expect(recco.resolveTrackIds).not.toHaveBeenCalled();
    expect(result.batchesTotal).toBe(0);
});

test('reports progress per batch, carrying only that batch results', async () => {
    const ids = Array.from({ length: 95 }, (_, i) => `t${i}`);
    const recco = {
        resolveTrackIds: jest.fn(async (batch) => new Map(batch.map(id => [id, `rb-${id}`]))),
        fetchAudioFeatures: jest.fn(async (rbIds) => new Map(rbIds.map(rb => [rb.replace('rb-', ''), { tempo: 100 }])))
    };
    const progress = [];

    await loadTrackFeatures({
        trackIds: ids, reccoClient: recco, sleep: noSleep,
        onProgress: (p) => progress.push({ done: p.batchesDone, total: p.batchesTotal, size: p.features.size })
    });

    expect(progress).toHaveLength(3);
    expect(progress[2]).toMatchObject({ done: 3, total: 3 });
    expect(progress.reduce((n, p) => n + p.size, 0)).toBe(95);
});

test('stops between batches when cancelled and reports completed false', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `t${i}`);
    let calls = 0;
    const recco = {
        resolveTrackIds: jest.fn(async () => { calls++; return new Map(); }),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };

    const result = await loadTrackFeatures({
        trackIds: ids, reccoClient: recco, sleep: noSleep,
        isCancelled: () => calls >= 2
    });

    expect(result.completed).toBe(false);
    expect(calls).toBe(2);
});

test('a failing batch is counted but does not stop the run, and is not poisoned', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `t${i}`);
    let call = 0;
    const recco = {
        resolveTrackIds: jest.fn(async (batch) => {
            call++;
            if (call === 1) throw Object.assign(new Error('429'), { kind: 'rate_limit', status: 429 });
            return new Map(batch.map(id => [id, `rb-${id}`]));
        }),
        fetchAudioFeatures: jest.fn(async (rbIds) => new Map(rbIds.map(rb => [rb.replace('rb-', ''), { tempo: 90 }])))
    };

    const result = await loadTrackFeatures({ trackIds: ids, reccoClient: recco, sleep: noSleep });

    expect(result.failedBatches).toBe(1);
    expect(result.batchesDone).toBe(2);
    // Nothing written for the failed batch, so those ids retry next launch.
    expect(await database.getTrackAudioFeatures('t0')).toBeUndefined();
});

test('spaces batches out but does not pad the final one', async () => {
    const ids = Array.from({ length: 95 }, (_, i) => `t${i}`);
    const recco = {
        resolveTrackIds: jest.fn().mockResolvedValue(new Map()),
        fetchAudioFeatures: jest.fn().mockResolvedValue(new Map())
    };
    const sleep = jest.fn().mockResolvedValue(undefined);

    await loadTrackFeatures({ trackIds: ids, reccoClient: recco, sleep });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(120);
});

test('an empty track list does no work', async () => {
    const recco = { resolveTrackIds: jest.fn(), fetchAudioFeatures: jest.fn() };

    const result = await loadTrackFeatures({ trackIds: [], reccoClient: recco, sleep: noSleep });

    expect(result).toMatchObject({ completed: true, batchesTotal: 0, added: 0 });
    expect(recco.resolveTrackIds).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=featuresLoader`
Expected: FAIL — cannot resolve `./featuresLoader.js`.

- [ ] **Step 3: Implement `src/sync/featuresLoader.js`**

Move the batching, throttling and record-writing logic out of `runFeaturesPhase` in `src/sync/syncEngine.js` into this module, adapted to report progress and honour cancellation.

```javascript
import * as reccobeats from '../reccobeats.js';
import * as database from '../database.js';

// ReccoBeats rate-limits on burst shape rather than volume. Measured: at concurrency
// 2 with no delay, 59 of 179 batches returned HTTP 429; sequential with a 120ms gap,
// zero. This runs one batch at a time by construction.
const FEATURES_BATCH_DELAY_MS = 120;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches audio features for whichever of `trackIds` have no stored record yet.
 *
 * Runs in the background, outside the blocking sync — the playlists are already
 * complete and correct by the time this starts, and a full load is ~2 minutes.
 *
 * Never throws: a failing batch is counted and skipped. Failed batches are
 * deliberately NOT written as not-found, so their ids stay in the missing set and
 * are retried on the next launch.
 */
async function loadTrackFeatures({
    trackIds,
    reccoClient = reccobeats,
    sleep = defaultSleep,
    onProgress = null,
    isCancelled = () => false
}) {
    const missing = await database.getTrackIdsMissingAudioFeatures(trackIds);

    const batches = [];
    for (let i = 0; i < missing.length; i += reccobeats.RECCOBEATS_BATCH_SIZE) {
        batches.push(missing.slice(i, i + reccobeats.RECCOBEATS_BATCH_SIZE));
    }

    let batchesDone = 0;
    let failedBatches = 0;
    let added = 0;

    for (let index = 0; index < batches.length; index++) {
        if (isCancelled()) {
            return { completed: false, batchesDone, batchesTotal: batches.length, failedBatches, added };
        }

        const batch = batches[index];
        let features = new Map();

        try {
            const idMap = await reccoClient.resolveTrackIds(batch);
            const found = idMap.size > 0
                ? await reccoClient.fetchAudioFeatures(Array.from(idMap.values()))
                : new Map();

            const records = batch.map((trackId) => {
                const f = found.get(trackId);
                return f
                    ? { id: trackId, ...f, source: 'reccobeats' }
                    : { id: trackId, source: 'reccobeats-notfound' };
            });

            await database.putTrackAudioFeaturesBatch(records);

            for (const record of records) {
                if (typeof record.tempo === 'number') {
                    features.set(record.id, record);
                    added++;
                }
            }
        } catch (error) {
            failedBatches++;
            features = new Map();
        }

        batchesDone++;
        if (onProgress) {
            onProgress({ batchesDone, batchesTotal: batches.length, failedBatches, features });
        }

        if (index < batches.length - 1) {
            await sleep(FEATURES_BATCH_DELAY_MS);
        }
    }

    return { completed: true, batchesDone, batchesTotal: batches.length, failedBatches, added };
}

export { loadTrackFeatures, FEATURES_BATCH_DELAY_MS };
```

- [ ] **Step 4: Remove the features phase from `src/sync/syncEngine.js`**

Delete `runFeaturesPhase`, the `FEATURES_CONCURRENCY` / `FEATURES_BATCH_DELAY_MS` / `defaultSleep` constants it used, the `reccobeats` import, and the `sleep` and `reccoClient` parameters from `runSync`.

Replace the features block at the end of `runSync` with a cached-only read:

```javascript
    // Cached tempos only — no network here. Fetching moved to a background loader
    // so a ~2 minute tempo load no longer sits inside a blocking backdrop.
    const trackIds = new Set();
    for (const playlist of [...mergedLibrary, ...mergedClass]) {
        for (const track of playlist.trackList ?? []) {
            if (track?.id) trackIds.add(track.id);
        }
    }
    const featuresById = await database.getAudioFeaturesMap(Array.from(trackIds));

    emit({ type: 'sync:complete', at: Date.now() });

    return { libraryPlaylists: mergedLibrary, classPlaylists: mergedClass, featuresById };
```

`runSync`'s signature becomes `async function runSync({ emit, spotifyClient = spotify })`.

- [ ] **Step 5: Remove the `features` phase from `src/sync/telemetry.js`**

Delete the `{ key: 'features', label: 'Track tempo' }` entry from `PHASES`. The backdrop must not render a phase that never runs — Stage 1's non-executing repair row was exactly that trap.

- [ ] **Step 6: Update the affected existing tests**

In `src/sync/syncEngine.test.js`, remove the tests that exercised the in-sync features phase — their coverage moves to `featuresLoader.test.js`. By name, these are the ones asserting: features are fetched for tracks lacking them; a catalogue miss is recorded; tracks with stored features are not re-requested; a recorded miss is not re-requested; batches never exceed 40; a features failure does not fail the sync; the features phase emits start/complete; a sync with no injected ReccoBeats client makes no network call; **and the two throttling tests** — `'the features phase spaces out batches but does not pad the final one'` and `'a single batch incurs no delay at all'`, which exist only because `runSync` took a `sleep` parameter that this task removes.

Also remove the `jest.mock('../reccobeats.js', ...)` block: `runSync` no longer imports that module, so the mock guards nothing.

Keep every test covering playlists, repair, staleness and pruning **unmodified**. Before deleting any test, confirm the equivalent assertion exists in `featuresLoader.test.js` — if something is only covered by a test you are about to delete, say so rather than dropping the coverage.

In `src/sync/telemetry.test.js`, remove or update the two tests asserting the `features` phase exists.

Add this test to `src/sync/syncEngine.test.js`:

```javascript
test('runSync returns cached features without any tempo network call', async () => {
    await database.putTrackAudioFeaturesBatch([{ id: 't1', tempo: 128, source: 'reccobeats' }]);
    const client = makeClient({
        playlists: [header('lib', '[LIBRARY] Main', 1)],
        itemsByPlaylist: { lib: [makeItem('t1')] }
    });

    const result = await runSync({ emit: () => {}, spotifyClient: client });

    expect(result.featuresById.get('t1')).toMatchObject({ tempo: 128 });
});
```

- [ ] **Step 7: Run the full suite and build**

Run: `CI=true bunx react-scripts test` then `CI=true bun run build`
Expected: all pass; "Compiled successfully", no warnings.

- [ ] **Step 8: Commit**

```bash
git add src/sync/ && git commit -m "refactor: move tempo fetching into a cancellable background loader"
```

---

### Task 2: The app bar progress chip

**Files:**
- Create: `src/components/TempoProgressChip.jsx`
- Test: `src/components/TempoProgressChip.test.jsx`

**Interfaces:**
- Consumes: nothing
- Produces: `<TempoProgressChip progress={...} />` where `progress` is
  `{ running, batchesDone, batchesTotal, failedBatches, added }` or `null`.
  Renders nothing when `progress` is null, or when the run finished with no failures.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/components/TempoProgressChip.test.jsx
import { render, screen } from '@testing-library/react';
import TempoProgressChip from './TempoProgressChip.jsx';

test('renders nothing when there is no run', () => {
    const { container } = render(<TempoProgressChip progress={null} />);

    expect(container).toBeEmptyDOMElement();
});

test('shows percentage while running', () => {
    render(<TempoProgressChip progress={{ running: true, batchesDone: 41, batchesTotal: 100, failedBatches: 0, added: 1200 }} />);

    expect(screen.getByTestId('tempo-progress')).toHaveTextContent('41%');
});

test('disappears on clean completion', () => {
    // No permanent chrome for a finished job.
    const { container } = render(
        <TempoProgressChip progress={{ running: false, batchesDone: 100, batchesTotal: 100, failedBatches: 0, added: 3000 }} />
    );

    expect(container).toBeEmptyDOMElement();
});

test('stays visible in a warning state when batches failed', () => {
    // Failures must not vanish silently — the column is still incomplete.
    render(<TempoProgressChip progress={{ running: false, batchesDone: 100, batchesTotal: 100, failedBatches: 7, added: 2500 }} />);

    const chip = screen.getByTestId('tempo-progress');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent(/7/);
});

test('reports how many tempos were added, in its tooltip label', () => {
    render(<TempoProgressChip progress={{ running: true, batchesDone: 10, batchesTotal: 100, failedBatches: 0, added: 400 }} />);

    expect(screen.getByLabelText(/400/)).toBeInTheDocument();
});

test('handles a zero-batch run without dividing by zero', () => {
    const { container } = render(
        <TempoProgressChip progress={{ running: false, batchesDone: 0, batchesTotal: 0, failedBatches: 0, added: 0 }} />
    );

    expect(container).toBeEmptyDOMElement();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=TempoProgressChip`
Expected: FAIL — cannot resolve `./TempoProgressChip.jsx`.

- [ ] **Step 3: Implement `src/components/TempoProgressChip.jsx`**

```jsx
import React from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import LinearProgress from '@mui/material/LinearProgress';

const GREEN = '#1DB954';
const AMBER = '#ffaa00';

/**
 * Background tempo-loading indicator for the app bar.
 *
 * Renders nothing when idle or when a run finished cleanly — a completed job should
 * leave no permanent chrome. It stays visible in a warning state when batches failed,
 * because the BPM column is then still incomplete and that must not be silent. Those
 * batches are retried on the next launch.
 */
function TempoProgressChip({ progress }) {
    if (!progress) return null;
    if (progress.batchesTotal === 0) return null;

    const { running, batchesDone, batchesTotal, failedBatches, added } = progress;
    if (!running && failedBatches === 0) return null;

    const pct = Math.round((batchesDone / batchesTotal) * 100);
    const label = running
        ? `Loading track tempo — ${pct}% complete, ${added} found so far`
        : `Tempo loading finished with ${failedBatches} failed batches; they will be retried next launch`;

    return (
        <Tooltip title={label}>
            <Box
                data-testid="tempo-progress"
                aria-label={label}
                sx={{
                    display: 'flex', alignItems: 'center', gap: 1,
                    px: 1.4, py: 0.6, mr: 1, borderRadius: '14px',
                    backgroundColor: 'rgba(255,255,255,0.07)',
                    fontSize: 12, whiteSpace: 'nowrap',
                    color: failedBatches > 0 ? AMBER : 'rgba(255,255,255,0.8)'
                }}
            >
                <Box component="span">♪</Box>
                <Box component="span">
                    {running ? `Tempo ${pct}%` : `Tempo · ${failedBatches} failed`}
                </Box>
                {running && (
                    <LinearProgress
                        variant="determinate"
                        value={pct}
                        sx={{
                            width: 48, height: 4, borderRadius: 2,
                            backgroundColor: 'rgba(255,255,255,0.15)',
                            '& .MuiLinearProgress-bar': { backgroundColor: GREEN }
                        }}
                    />
                )}
            </Box>
        </Tooltip>
    );
}

export default TempoProgressChip;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CI=true bunx react-scripts test --testPathPattern=TempoProgressChip`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/TempoProgressChip.jsx src/components/TempoProgressChip.test.jsx
git commit -m "feat: add background tempo-loading chip for the app bar"
```

---

### Task 3: Wire the background load into the app

**Files:**
- Modify: `src/App.jsx`
- Test: `src/App.test.jsx`

**Interfaces:**
- Consumes: `loadTrackFeatures`, `TempoProgressChip`
- Produces: nothing consumed elsewhere

- [ ] **Step 1: Write the failing tests**

Add to `src/App.test.jsx`, keeping the existing test:

```javascript
test('starts loading tempo in the background once the sync completes', async () => {
    jest.spyOn(database, 'init').mockResolvedValue(undefined);
    spotify.isAuthorized.mockResolvedValue(true);
    spotify.getAccessToken.mockReturnValue('token');
    syncEngine.runSync.mockResolvedValue({
        libraryPlaylists: [], classPlaylists: [], featuresById: new Map()
    });
    featuresLoader.loadTrackFeatures.mockResolvedValue({
        completed: true, batchesDone: 0, batchesTotal: 0, failedBatches: 0, added: 0
    });

    render(<App />);

    await waitFor(() => {
        expect(featuresLoader.loadTrackFeatures).toHaveBeenCalled();
    });
});

test('does not start a background load when the sync failed', async () => {
    // Nothing useful to enrich, and the backdrop is showing an error.
    jest.spyOn(database, 'init').mockResolvedValue(undefined);
    spotify.isAuthorized.mockResolvedValue(true);
    spotify.getAccessToken.mockReturnValue('token');
    syncEngine.runSync.mockRejectedValue(
        Object.assign(new Error('Spotify API error: 403'), { kind: 'auth', status: 403 })
    );

    render(<App />);

    await waitFor(() => {
        expect(screen.getByTestId('sync-fatal-error')).toBeInTheDocument();
    });
    expect(featuresLoader.loadTrackFeatures).not.toHaveBeenCalled();
});
```

Add `import * as featuresLoader from './sync/featuresLoader.js';` and `jest.mock('./sync/featuresLoader.js');` alongside the existing mocks, and reset it in a `beforeEach`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `CI=true bunx react-scripts test --testPathPattern=App`
Expected: FAIL — `loadTrackFeatures` never called.

- [ ] **Step 3: Add the background-load machinery to `src/App.jsx`**

Add imports:

```jsx
import { loadTrackFeatures } from './sync/featuresLoader.js';
import TempoProgressChip from './components/TempoProgressChip.jsx';
```

Add state and refs alongside the existing hooks:

```jsx
  const [tempoProgress, setTempoProgress] = useState(null);
  // Features arrive per batch but are flushed to the table on a timer — 179
  // rebuilds of a 7,000-row virtualised grid would jank while scrolling.
  const pendingTempoRef = React.useRef(new Map());
  // Bumped on every new run so an in-flight loader can tell it has been superseded.
  const tempoRunRef = React.useRef(0);
```

Add the flush helper and the starter, above `getData`:

```jsx
  const flushPendingTempo = useCallback(() => {
    if (pendingTempoRef.current.size === 0) return;

    const pending = pendingTempoRef.current;
    pendingTempoRef.current = new Map();

    setTrackLibrary((rows) =>
      rows.map((row) => (pending.has(row.id) ? { ...row, tempo: pending.get(row.id).tempo } : row))
    );
  }, []);

  const startBackgroundTempoLoad = useCallback((playlists) => {
    const runId = ++tempoRunRef.current;
    const isCancelled = () => tempoRunRef.current !== runId;

    const trackIds = Array.from(new Set(
      playlists.flatMap((playlist) => (playlist.trackList ?? []).map((track) => track?.id).filter(Boolean))
    ));

    setTempoProgress({ running: true, batchesDone: 0, batchesTotal: 0, failedBatches: 0, added: 0 });
    const flushTimer = setInterval(flushPendingTempo, 2000);

    loadTrackFeatures({
      trackIds,
      isCancelled,
      onProgress: ({ batchesDone, batchesTotal, failedBatches, features }) => {
        if (isCancelled()) return;
        for (const [id, record] of features) pendingTempoRef.current.set(id, record);
        setTempoProgress((current) => ({
          ...(current ?? {}), running: true, batchesDone, batchesTotal, failedBatches,
          added: (current?.added ?? 0) + features.size
        }));
      }
    })
      .then((result) => {
        if (isCancelled()) return;
        setTempoProgress({ running: false, ...result });
      })
      .catch((error) => {
        console.warn('Background tempo load failed', error);
        if (!isCancelled()) setTempoProgress(null);
      })
      .finally(() => {
        clearInterval(flushTimer);
        if (!isCancelled()) flushPendingTempo();
      });
  }, [flushPendingTempo]);
```

In `getData`'s success path, after `setTrackLibrary(...)` and `setIsLoading(false)`, add:

```jsx
      startBackgroundTempoLoad([..._libraryPlaylists, ..._classPlaylists]);
```

and add `startBackgroundTempoLoad` to `getData`'s dependency array.

- [ ] **Step 4: Render the chip in the app bar**

In `TopShell`'s `<Toolbar>`, immediately before the "Refresh Authorization" `Tooltip`, add:

```jsx
            <TempoProgressChip progress={tempoProgress} />
```

- [ ] **Step 5: Cancel on unmount**

Add this effect alongside the others so a loader cannot outlive the component:

```jsx
  useEffect(() => {
    // Bumping the run id makes any in-flight loader see itself as superseded.
    return () => { tempoRunRef.current++; };
  }, []);
```

- [ ] **Step 6: Run the full suite and build**

Run: `CI=true bunx react-scripts test` then `CI=true bun run build`
Expected: all pass; "Compiled successfully", no warnings.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/App.test.jsx
git commit -m "feat: load track tempo in the background with an app-bar indicator"
```

---

### Task 4: Live verification

- [ ] **Step 1: Clear only the features store**

From devtools on the running app's origin, clear `tracksAudioFeatures` but leave `playlists` and `syncState` intact, so this exercises a full tempo load without a Spotify re-sync.

- [ ] **Step 2: Reload and observe**

| Check | Expected |
| --- | --- |
| Backdrop phases | Four — no "Track tempo" row |
| Time to interactive table | Back to ~1–2 s warm |
| App bar chip | Appears, climbs, shows a percentage |
| BPM column | Fills in progressively while the table stays usable |
| Chip on completion | Disappears (clean) or shows a failed count |
| Console 429s | Zero |

- [ ] **Step 3: Confirm cancellation**

Hit Refresh mid-load. The old loader must stop rather than run alongside the new one — watch that the chip resets rather than jumping between two percentages.

- [ ] **Step 4: Confirm convergence**

Reload once loading has finished. The chip should not appear at all, and there should be zero ReccoBeats requests.

- [ ] **Step 5: Record results in the spec and commit**
