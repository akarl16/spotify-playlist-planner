# Spotify Sync: Observability, Correctness, and Storage

**Date:** 2026-07-27
**Status:** Approved design, pending implementation plan

## Problem

Syncing Spotify data into local storage has been unreliable for as long as the app
has existed. The assumption was that Spotify's rate limiting was the cause. Rate
limiting is real, but it is not the root cause.

The root cause is that **a single rate-limit response or token expiry permanently
corrupts a playlist's cached tracks, and nothing in the system can detect or repair
it.**

### The failure chain

1. `getPlaylistTracks` fans out over every playlist at once with an unbounded
   `Promise.all` (`App.jsx:191`). With hundreds of playlists this is hundreds of
   concurrent paginated fetch chains, which reliably provokes HTTP 429.

2. `retrievePlaylistTracks` tries to handle 429 by checking `e.status === 429`
   (`App.jsx:227`). But `getPlaylistItems` throws a plain `new Error(...)` with no
   `status` property (`spotify.js:265`). **The retry branch is unreachable.** Every
   429 falls through to `break`, returning a partial track list.

3. That partial list is written to IndexedDB as though complete (`App.jsx:195-196`).

4. `setPlaylistNoOverwrite` only re-fetches a playlist when its `snapshot_id`
   changes (`database.js:49-62`). A playlist truncated by a 429 has an unchanged
   `snapshot_id`, so **it is never re-fetched.** The truncation is permanent.

Nothing in the stored data distinguishes a complete track list from a truncated
one, so the corruption is also undetectable after the fact.

### Correction from Stage 0 measurement

The Stage 0 audit (below) confirmed the chain above but showed the failure has
**two distinct modes**, not one — and the more common mode has a second,
independent cause that this section originally missed.

**Mode A — small playlists fail to an empty array.** A playlist that fits in one
page makes exactly one request. If that request 429s, `retrievePlaylistTracks`
breaks with `tracks` still empty and returns `[]`. That empty array is stored, and
then:

```js
if (!playlistHeader.trackList)   // App.jsx:193 — [] is TRUTHY
```

**An empty array passes this check**, so the playlist is skipped on every
subsequent sync forever. `snapshot_id` never enters into it. This is the dominant
failure by count: 440 of 555 class playlists are permanently empty.

**Mode B — large playlists truncate mid-pagination.** A playlist spanning many
pages fails partway, stores a partial list, and is then pinned by the unchanged
`snapshot_id` as originally described. This is the dominant failure by volume:
4 of 15 library playlists, accounting for 3,735 of the 14,608 missing tracks.

Both modes must be fixed. Mode A is not addressed by sync-state tracking alone —
the emptiness check itself is wrong.

### Contributing defects

| Defect | Location | Effect |
| --- | --- | --- |
| **`[]` is truthy, so an empty track list counts as "already fetched"** | `App.jsx:193` | **440 playlists permanently empty — the single largest source of damage** |
| Headers fetched only when the DB is completely empty | `App.jsx:147-153` | Playlists created in Spotify never appear without a manual refresh |
| Access token read from a stale module variable | `spotify.js:249` | Long syncs cross the 1-hour token lifetime, hit 401, and truncate the same way a 429 does |
| `tx.done` never awaited; callers never await writes | `database.js:36-43`, `App.jsx:152`, `App.jsx:375` | `refreshData` races its own writes; write failures are silently dropped |
| Deleted playlists never pruned | `setPlaylists` only adds and updates | Store accumulates playlists that no longer exist |
| No `Retry-After` handling | fixed 6s sleep, itself unreachable | Backoff ignores Spotify's own guidance |
| `sort((a, b) => a.name - b.name)` | `App.jsx:392` | String subtraction yields `NaN`; the sort is a silent no-op |
| ~~Tracks duplicated across playlists~~ | `playlists.trackList` embeds full track objects | Measured at only 1.53× / 1.8 MB — **not a real problem**; normalization cut from scope |
| `buildTrackLibrary` mutates the objects it reads | `App.jsx:307-339` | Repeat calls in one session accumulate duplicate list names and overwrite `added_at` |

### Out of scope

`getsongbpm.js`, the `api/getsongbpm` proxy, `getTracksNeedingBpmAnalysis`, and the
commented-out audio-feature columns are dead — nothing imports them, and
`getTracksNeedingBpmAnalysis` reads `item.track` against a flat `trackList`, so it
returns an empty array unconditionally. Spotify removed `/audio-features` access in
November 2024. This code is left untouched by this work. It is harmless where it
sits and deserves its own decision later.

## Goals

1. Make sync progress and sync failure visible to the user while a sync runs.
2. Establish, from a real run, where time goes and where failures occur.
3. Make truncation detectable across reloads and automatically repairable.
4. Stop provoking rate limits, and survive them when they happen.
5. Stop `buildTrackLibrary` mutating the track objects it reads.

## Non-goals

- Background or non-blocking sync. The app continues to block behind a backdrop
  until sync completes. This was an explicit decision: one code path, and the user
  always looks at complete data.
- Reviving BPM / audio features.
- Any server-side component. The app stays client-only.

## Staging

The work lands in two stages, in this order, for a specific reason.

Adding a `status` property to thrown Spotify errors makes the currently-unreachable
429 retry branch reachable. That is a behavior change. If it lands together with the
instrumentation, the "baseline" run measures already-improved behavior and tells us
nothing about the problem we set out to characterize.

**Stage 1 — observe.** Telemetry, backdrop UI, and the `syncState` store. On a 429
the engine still stops and persists what it has, exactly as today — but now records
that the playlist is incomplete and why. Produces a baseline run.

Stage 1's engine is a **behavior-preserving refactor of the network path**. It
deliberately keeps these defects intact so the baseline measures the real problem:

- unbounded concurrency (no worker pool)
- `break` on any fetch error, with no retry
- headers fetched only when the store is empty
- no pruning of deleted playlists
- no repair phase (the UI row renders, but does not execute)

This separates "did the refactor change anything" from "did the fixes work". Every
one of these is corrected in Stage 2.

**Stage 2 — fix.** Retry, backoff, bounded concurrency, token refresh, header
staleness, pruning, repair pass. Re-run and compare against the Stage 1 baseline.

Decisions taken after the Stage 1 baseline:

- **Pool size is a fixed named constant, starting at 4.** Not adaptive. The
  instrumentation already reports the 429 rate directly, so tuning is a matter of
  re-running at different values and reading the number off the backdrop. Ship
  whichever value measures clean.
- **Repair executes as the final phase of the same run**, behind the same backdrop.
  One code path, and the user ends a single pass holding correct data. This forces
  fixing the `runSync`-snapshot trap, which has to be handled regardless.
- **Retry is turned on only after concurrency is bounded.** Retrying into a
  saturated limiter extends the storm; the pool has to come down first.

### Stage 0 — zero-code audit

Before either stage, the existing IndexedDB contents can be read directly from a
browser to quantify current damage: playlist count, class-playlist count, total
stored tracks, and per-playlist stored-track counts against each header's
`tracks.total`. This requires no code changes and no sync run, and answers the
open question of how large this library actually is.

## Architecture

`App.jsx` is 940 lines carrying UI, sync orchestration, Spotify pagination, and
library construction. Sync logic must be extractable to be observable and testable.

| Module | Status | Responsibility |
| --- | --- | --- |
| `src/spotify.js` | modify | Add a single `spotifyFetch()` chokepoint. Typed errors, token handling, retry (Stage 2). All Spotify traffic routes through it. |
| `src/sync/syncEngine.js` | new | Phase orchestration, bounded worker pool, emits telemetry events |
| `src/sync/syncState.js` | new | Per-playlist sync bookkeeping, backed by IndexedDB |
| `src/sync/telemetry.js` | new | Reduces the engine's event stream into the shape the backdrop renders |
| `src/components/SyncBackdrop.jsx` | new | The progress UI |
| `src/trackLibrary.js` | new | `buildTrackLibrary` extracted as a pure function |
| `src/database.js` | modify | v3 schema (adds `syncState`), awaited transactions |
| `src/App.jsx` | modify | Reduced to composition and the table |

The engine emits events; it does not import React. The telemetry reducer turns
events into view state. The backdrop renders view state. Each piece is testable
without the other two.

## Data model (IndexedDB v2 → v3)

### Stores

**Track normalization was cut after Stage 0.** It was originally in scope on the
assumption of heavy track duplication. Measurement showed 1.53× duplication and
1.8 MB of a 10.2 GB quota — a full, correct sync projects to single-digit MB. The
migration is therefore additive only: `playlists` keeps its existing `trackList`
shape and no `tracks` store is created. The `buildTrackLibrary` mutation bug that
normalizing would have fixed incidentally is now fixed directly instead, which is
the smaller change.

`playlists` — **unchanged from v2.**

```js
{
  id,
  name,
  description,
  snapshot_id,
  owner,
  tracks: { total },                       // Spotify's header count
  trackList: [{ id, added_at, name, artists, duration_ms }]
}
```

`syncState` — new, keyed by playlist id.

```js
{
  playlistId,
  snapshotId,                         // snapshot_id this state describes
  status,                             // 'complete' | 'incomplete' | 'failed' | 'never'
  fetchedItemCount,                   // raw items seen from the API, before filtering
  storedTrackCount,                   // trackList.length after filtering
  tracksTotal,                        // header's tracks.total at sync time
  lastAttemptAt,
  lastSuccessAt,
  attempts,
  lastError                           // { kind, status, message } | null
}
```

`lastError.kind` is one of `'rate_limit' | 'auth' | 'network' | 'http'`. The
distinction matters: a 429 truncation and a token-expiry truncation need different
fixes, and the UI names the cause rather than only the count.

`tracksAudioFeatures` and `artists` are carried forward unchanged (dead, but out of
scope).

### Why `syncState` is a separate store

`setPlaylistNoOverwrite` replaces playlist records wholesale, which would clobber
bookkeeping stored alongside them. Sync state also changes on a different cadence
than playlist content, and updating a counter should not require rewriting a
multi-thousand-entry array.

### Completeness

**A playlist is `complete` if and only if its pagination loop reached
`next === null` with zero errors.** Nothing else is authoritative.

`tracksTotal` is explicitly *not* a completeness test. `App.jsx:238` filters out
local files, podcast episodes, and unavailable tracks, so a perfectly healthy
playlist stores fewer tracks than `tracks.total` reports. `fetchedItemCount` (raw,
pre-filter) is recorded so `tracksTotal` remains useful as a diagnostic signal
without being load-bearing.

### Emptiness is never a skip signal

Stage 0 found 440 playlists holding `trackList: []` that the old code skipped
forever because `[]` is truthy. Anywhere the engine decides whether a playlist
needs fetching, the test is on **length**, never on presence:

```js
if (existing?.trackList?.length) { /* already have data */ }   // correct
if (existing?.trackList)         { /* WRONG — [] passes */ }
```

### Migration v2 → v3

Additive only. Runs inside the `versionchange` transaction:

1. Create the `syncState` store.
2. Write a `syncState` record per existing playlist with `status: 'never'`, so
   every pre-existing playlist is treated as unverified and eligible for repair.
   Existing cached data is *not* trusted, because we know 78 % of it is damaged
   and cannot tell which records from the inside.

No playlist record is rewritten and no track data is moved, so the migration is
cheap and its blast radius is limited to a store that did not previously exist.

The migration is local-only with no network calls. `added_at` values are `Date`
objects and survive structured clone unchanged.

### The `buildTrackLibrary` mutation bug

`buildTrackLibrary` mutates the track objects it reads (`track.lists += ...`,
`track.plays = []`, and it overwrites `playlistTrack.added_at` — `App.jsx:307-339`).
Those objects come straight out of IndexedDB, so a second call within one session
re-decorates already-decorated data and accumulates duplicate list names.

Normalizing was going to fix this incidentally. With normalization cut, it is fixed
directly: the extracted function builds fresh view models keyed off the stored
tracks and never writes to its inputs. A test asserts the inputs are untouched.

## Sync engine

### Phases

Both stages run the same four phases and render the same four UI rows. What differs
is what each phase is permitted to do.

| # | Phase | Stage 1 | Stage 2 |
| --- | --- | --- | --- |
| 1 | **Playlist headers** — paginate `getUserPlaylists`, upsert headers | Fetches only when the store is empty. No pruning. | Fetches on a staleness window. Prunes stored playlists absent from the response. |
| 2 | **Library playlists** — matching `[LIBRARY]` | Fetches any playlist lacking tracks | Additionally skips playlists already `complete` at the current `snapshot_id` |
| 3 | **Class playlists** — matching the date pattern | as above | as above |
| 4 | **Repair** — re-fetch playlists not `complete`, or whose `snapshotId` no longer matches the header | **Row renders as pending and lists the queue, but does not execute.** Executing it would repair damage mid-baseline and destroy the measurement. | Executes |

Phase 4 is what closes the loop on truncation. It is a visible phase in the UI so
repairs are observable rather than implicit.

### Concurrency

**Stage 2.** A bounded worker pool, default 4, replaces the unbounded `Promise.all`.
The pool size is a single named constant so a run can be repeated at different
values to find where 429s begin.

Stage 1 retains the unbounded fan-out. This is the single largest contributor to the
429 rate, and the baseline needs to capture it.

### Retry (Stage 2)

`spotifyFetch()` throws `SpotifyApiError` carrying `status` and `retryAfter`.

- **429** — wait `Retry-After` when present, otherwise exponential backoff with
  jitter. Capped attempts; on exhaustion the playlist is marked `incomplete`, never
  silently truncated.
- **401** — refresh the token once and retry. Token is read through an accessor
  that refreshes ahead of expiry rather than from a stale module variable.
- **5xx / network** — exponential backoff with jitter, capped attempts.
- **Other 4xx** — fail immediately; retrying will not help.

A partial result is **never** persisted as complete under any error path.

## Sync backdrop UI

Blocking, as today, with progressive disclosure.

**Collapsed (default).** Title, elapsed time, estimated remaining, overall progress
bar, and one row per phase with a status icon and counts. The active phase shows its
own progress bar. Calm by default.

**Failure badge.** When a phase has failures, a red count badge appears on that
phase row in the collapsed view. This is load-bearing: without it the details drawer
is undiscoverable at exactly the moment it matters. It appears only when something
has actually failed; a clean sync shows nothing.

**Expanded (on "Show details").** Adds:

- a live activity feed nested *under the active phase*, so the phase list stays the
  spine of the layout rather than splitting attention across two lists
- per-phase API call counts and elapsed time
- a rate-limit banner while backoff is active, with observed 429 rate
- an incomplete-playlist callout naming the cause per playlist, e.g. "stopped at 50
  of 112 tracks (429)" versus "token expired mid-fetch"
- a summary stat line: API calls, rate-limited count, failures, tracks cached

Approved mockup, showing both states of the same sync:
[`assets/2026-07-27-sync-backdrop-mockup.html`](assets/2026-07-27-sync-backdrop-mockup.html)
(open in a browser; it is a standalone fragment styled to match the app's dark theme).

## Testing

The repo has `react-scripts test` configured and zero test files. Retry, backoff,
and token-expiry paths are impractical to trigger deliberately against a live API,
which is precisely why they were broken for so long without anyone noticing.

Add `fake-indexeddb`, then cover:

| Target | What it proves |
| --- | --- |
| `spotifyFetch` retry logic | 429 honors `Retry-After`; 401 refreshes once and retries; 4xx fails fast; attempts are capped |
| Worker pool | Concurrency never exceeds the cap; failures don't stall the pool |
| `syncState` transitions | A pagination loop cut short records `incomplete`, never `complete` |
| Migration v2 → v3 | `syncState` is created; every existing playlist lands at `status: 'never'`; no playlist record is altered |
| `buildTrackLibrary` | Recency scoring, play aggregation, list membership; no input mutation |

The `syncState` and migration tests are the ones that would have caught the original
bug.

## Verification

Stage 1 baseline and Stage 2 comparison run against the same account, captured from
the backdrop's own stat line plus the console:

- playlist count, class-playlist count, total unique tracks
- wall-clock time per phase
- API call count and 429 count
- playlists ending `incomplete`, by cause
- IndexedDB size

Stage 2 succeeds when the 429 count drops materially and the `incomplete` count
reaches zero across two consecutive runs.

## Risks

**The migration touches all stored data.** It runs in a `versionchange`
transaction, so it either fully commits or fully aborts. The pre-migration store is
already known to contain truncated data, and every playlist is marked `never` after
migration, so a bad migration degrades to a full re-sync rather than data loss.

**Stage 2 makes cold sync slower.** Bounded concurrency and honest backoff are
strictly slower than firing everything at once and dropping whatever fails. This is
the correct trade and is the reason the backdrop work comes first.

**The `never` seeding forces a full re-sync.** Marking all 628 playlists unverified
means the first Stage 2 run re-fetches everything rather than trusting any cached
data. That is deliberate — 78 % of it is damaged and the damage is not detectable
from the inside — but it makes that run long.

## Stage 0 results

Measured 2026-07-27 against the live IndexedDB at
`https://spotify-playlist-planner-liard.vercel.app` (database `playlist-planner`,
version 2). Read-only; no sync was triggered.

The GitHub Pages origin holds no `playlist-planner` database — Vercel is the only
deployment carrying real data.

### Scale

| Measure | Value |
| --- | --- |
| Playlists stored | 628 |
| Library playlists (`[LIBRARY]`) | 15 |
| Class playlists (date-named) | 555 |
| Neither (never fetched by design) | 58 |
| Unique tracks cached | 4,348 |
| Total track entries across playlists | 6,632 |
| Duplication factor | 1.53× |
| IndexedDB usage | 1.8 MB of a 10.2 GB quota |

### Damage

| Measure | Value |
| --- | --- |
| Playlists short of `tracks.total` | 445 of 570 in scope |
| Tracks missing | 14,608 |
| Class playlists with an **empty** track list | 440 of 555 |
| Library playlists truncated mid-pagination | 4 of 15 |
| Playlists ending on an exact 50-track page boundary | 5 |

**78 % of in-scope playlists are damaged.** Only 114 of 555 class playlists and 11
of 15 library playlists hold complete data.

### Library playlist detail

Every library playlist under 250 tracks is complete. Every library playlist over
750 tracks is truncated, each at an exact multiple of 50:

| Playlist | Stored | Actual | Missing |
| --- | --- | --- | --- |
| Cycle Tempo | 500 | 3,390 | 2,890 |
| Cycle Easy | 700 | 1,106 | 406 |
| Cycle party | 700 | 1,072 | 372 |
| Cycle Openers | 700 | 767 | 67 |
| *(11 others)* | complete | — | 0 |

Cycle Tempo — the largest source playlist — is missing **85 %** of its tracks.
Track selection has been drawing from a sixth of the intended library.

### What this changes

**The `[]`-is-truthy bug is the dominant failure mode** and was not in the original
diagnosis. See "Correction from Stage 0 measurement" above. Any fix that only
addresses `snapshot_id` staleness would leave 440 playlists permanently empty.

**The 50-track page boundary is confirmed as the truncation signature.** All four
truncated library playlists stopped at 500 or 700 — 10 and 14 pages respectively.
Nothing stops at an arbitrary offset, which rules out per-track data errors and
points squarely at whole-request failures during pagination.

**Class playlists are effectively all-or-nothing.** They fit in one page, so they
either complete on the first request or store `[]`. 114 of the 115 populated class
playlists are complete.

**Storage normalization is not justified by storage pressure.** Measured
duplication is 1.53× and total usage is 1.8 MB against a 10 GB quota. A full,
correct sync would raise entries to roughly 21,000 and usage to single-digit
megabytes — still negligible.

**Decision: normalization was cut from scope** on this evidence. The correctness
benefit it carried (removing the `buildTrackLibrary` mutation bug) is achieved
directly and more cheaply, and dropping it shrinks the riskiest part of the
migration to nothing — the v3 upgrade no longer rewrites all 628 playlist records.

## Stage 1 baseline

Measured 2026-07-28 on `localhost:3002` against a genuinely cold IndexedDB (fresh v3
database, nothing cached). The engine ran with all five Stage 1 defects intact —
unbounded fan-out, no retry, no repair execution.

Authentication note: port 3000 was occupied, and it holds the only registered
localhost redirect URI. The session was obtained by authorising on the Vercel origin
(a registered URI) and moving the resulting refresh token to the localhost origin.
The refresh grant does not involve `redirect_uri`, so this needs no dashboard change.

### Outcome

| Measure | Value |
| --- | --- |
| Playlists discovered | 631 (13 header requests) |
| In scope (library + class) | 573 |
| `complete` | **111** |
| `incomplete` (partial) | **3** |
| `failed` (zero tracks) | **459** |
| Total failures | **462 of 573 — 81 %** |
| Tracks stored | 7,065 |
| Tracks missing vs `tracks.total` | 14,299 |
| Playlists left holding `[]` | 517 |
| IndexedDB usage | 4.47 MB |
| Request latency p50 / p95 / max | 425 ms / 643 ms / 717 ms |

### The finding

**Every single failure was `rate_limit`. All 462 of them.**

```
byErrorKind: { rate_limit: 462 }
```

Zero `auth`, zero `network`, zero other HTTP. Token expiry — listed in the original
diagnosis as a co-equal cause — contributed nothing. The typed-error work from Task 3
is what makes this statement possible; previously every failure was an untyped
`Error` and indistinguishable.

**459 of 462 failures stopped at zero tracks.** Only 3 playlists truncated
mid-pagination. This confirms Mode A as overwhelmingly dominant and matches Stage 0
exactly: small playlists make one request, that request is rate-limited, and `[]` is
stored.

**A cold sync reproduces six months of accumulated production damage in about half a
minute.** Stage 0 measured 445 damaged playlists in a cache built up over months;
this run produced 462 from scratch. The damage was never gradual accumulation — it
is what a single unthrottled sync does every time.

### API call volume

Resource Timing caps at 250 entries so the browser-side count is truncated. Derived
from sync state: 13 header requests + 459 single-request failures + ~141 pages for
the 111 complete playlists + partials ≈ **610 requests, of which 462 (roughly 75 %)
returned 429.**

### What this determines for Stage 2

1. **Bounded concurrency is the entire fix.** With one cause accounting for 100 % of
   failures, retry and a worker pool are not two of several improvements — they are
   the work. Everything else on the Stage 2 list is hygiene.
2. **Retry alone would be insufficient and possibly harmful.** Retrying 462 requests
   into an already-saturated rate limiter extends the storm. Concurrency must come
   down first, with retry as the safety net.
3. **Pool sizing.** 573 playlists at ~425 ms p50 gives roughly 244 s of serial work.
   A pool of 4–8 targets 30–60 s while staying far below the burst that produced a
   75 % rejection rate. Start at 4 and raise it only if the observed 429 rate stays
   near zero.
4. **Token refresh is lower priority than assumed.** No auth failure occurred in a
   ~30 s run. It still matters once bounded concurrency stretches a sync past the
   one-hour token lifetime — which is a new risk created by the fix, not an existing
   one.

### UI defect found by this run

The expanded details panel rendered all 462 incomplete entries unbounded, pushing the
stats line and the collapse control off screen. Unit tests missed it because they
supply a single failure. Fixed: the list renders 8 rows plus an "…and N more"
summary, and the panel is capped at `90vh` with scroll. `telemetry.incomplete` still
holds every entry — only the rendering is capped.

## Carried into Stage 2

Two structural issues surfaced by the whole-branch review. Neither is a bug today —
both are traps the Stage 2 work will spring if not handled deliberately.

**`runSync` snapshots its return value before repair runs.** It builds and sorts
`libraryPlaylists` / `classPlaylists`, and only then calls `reportRepairQueue`. That
is harmless while repair does no work. Once Stage 2's repair phase actually re-fetches,
the repaired records will not be in the arrays handed back to `App.jsx` and
`buildTrackLibrary` — the user would see pre-repair data until a reload. Either repair
must update those arrays in place, or `runSync` must re-read from IndexedDB after the
repair phase completes.

**The skip predicate and `needsSync` have diverged.** The engine skips on
`existing?.trackList?.length` (`syncEngine.js`), while `needsSync` — written, exported
and unit-tested in `syncState.js` — is used only by the repair queue. Stage 2 needs
both at that one call site: a snapshot-aware skip, *and* a force path, because repair
must not be skipped by the very partial data it exists to replace. Reconcile the two
rather than adding a third rule.

**Deferred minor, worth folding into the retry work.** A 200 response with a
non-JSON body throws a raw `SyntaxError` from `response.json()` rather than a
`SpotifyApiError`, so `syncState` types it `kind: 'http'`. Harmless now, but the
headline Stage 1 finding is the purity of `byErrorKind`, and that claim should stay
trustworthy once retry starts branching on error kind.

## Stage 2 — pool-only measurement

Bounded concurrency landed alone, with no retry, no token refresh, and no repair
execution, so the change is attributable to concurrency and nothing else. Three cold
runs against the same 573-playlist library, each from a freshly deleted IndexedDB.

| Measure | Unbounded (baseline) | Pool = 4 | Pool = 2 |
| --- | --- | --- | --- |
| `complete` | 111 | 407 | **573** |
| `failed` | 459 | 166 | **0** |
| `incomplete` | 3 | 0 | **0** |
| `byErrorKind` | `{ rate_limit: 462 }` | `{ rate_limit: 166 }` | **`{}`** |
| Tracks stored | 7,065 | 17,311 | **21,353** |
| Cycle Tempo | 500 / 3,390 | 3,398 / 3,398 | **3,398 / 3,398** |
| Wall clock | ~30 s | ~70 s | 119 s |

**A pool of 2 produces a completely clean sync.** Not a reduced error rate — zero
errors of any kind, across all 573 in-scope playlists. The 58 playlists still holding
an empty track list are the out-of-scope ones (neither library nor class), which are
correctly never fetched.

### What this changes about the plan

**Retry is no longer the fix; it is insurance.** The plan ordered retry second on the
assumption that bounded concurrency would reduce but not eliminate rate limiting. It
eliminated it. Retry still has value — one clean run is not proof of zero 429s under
a slower network, a larger library, or Spotify-side variability — but it is now a
safety net rather than a correctness requirement.

**The cost is wall clock.** 119 s versus ~30 s, all of it behind a blocking backdrop.
That is the price of correctness at this pool size. A pool of 4 finishes in ~70 s but
leaves 166 playlists damaged, which repair would then have to re-fetch on a later run
— so the apparent saving is partly illusory.

**Progress reporting held up.** The overall bar was strictly monotonic across 119
samples, confirming both the Stage 1 fix and Task 1's change to publish both
fetch-phase totals before either phase begins.

## Stage 2 results

Verification run 2026-07-28, after all Stage 2 work landed — bounded concurrency,
header staleness and pruning, an executing repair phase, retry, and the two fixes
from the final whole-branch review.

| Measure | Stage 1 baseline | Stage 2 run 1 (cold) | Stage 2 run 2 (immediate) |
| --- | --- | --- | --- |
| `complete` | 111 | **573** | **573** |
| `failed` | 459 | **0** | **0** |
| `incomplete` | 3 | **0** | **0** |
| `byErrorKind` | `{ rate_limit: 462 }` | **`{}`** | **`{}`** |
| Tracks stored | 7,065 | **21,353** | 21,353 |
| Cycle Tempo | 500 / 3,390 | **3,398 / 3,398** | 3,398 / 3,398 |
| Wall clock | ~30 s | 128 s | **0 s** |
| Spotify requests | ~610 | ~700 | **0** |

**The success criterion is met.** `incomplete` and `failed` are both zero across two
consecutive runs, and the second run performs no network work at all — repair
converges rather than re-fetching, and nothing ping-pongs between phases.

Cycle Tempo holds all 3,398 tracks. It held 500 of 3,390 when this work started.

### What the verification also confirmed

**The measured-clean result survived the later commits.** The pool-only measurement
was taken before header staleness, repair execution, retry, and two Critical fixes
landed. Run 1 reproduces it exactly — none of that work reintroduced request volume
or concurrency.

**Progress reporting is monotonic** across the full 128 s run, with no regressions.

**A real failure surfaces correctly.** Mid-verification the access token was rejected
and the sync aborted. The backdrop showed "Sync stopped", named the cause, and
offered a retry — exactly the behavior Stage 1's telemetry work was for.

### A bug the live run caught that tests could not

That failure exposed a defect in `App.jsx`'s error path. Its `catch` block did
`return`, intending to keep the backdrop mounted so the user sees the reason — but
`setIsLoading(false)` sat in the `finally`, and **`finally` runs even on the way out
of a `return`**. The backdrop unmounted regardless and a real HTTP 403 produced a
completely silent empty table: precisely the outcome that code exists to prevent.

Fixed by clearing the loading flag on the success path only. This also produced the
first test for `App.jsx`, verified to fail without the fix. Two rounds of unit tests
and three code reviews had passed over this path without catching it, because nothing
rendered the component against a rejecting sync.

## Track tempo results

Verified 2026-07-29. Tempo is fetched from ReccoBeats as a fifth sync phase, keyed by
Spotify track id.

| Measure | Value |
| --- | --- |
| Records written | 7,135 — every unique track |
| Tracks with tempo | **4,935 (69.2 %)** |
| Recorded `reccobeats-notfound` | 2,199 |
| Tempo range / median | 55–228 / **123 BPM** |
| Requests | ~358 (179 batches × 2 endpoints) |
| Second run | 0 requests |

Coverage matches the standalone probe taken before any code was written (4,936 /
2,199), so the implementation loses nothing to the pipeline.

### ReccoBeats rate-limits, and the plan said it would not

The plan asserted no throttling was needed, citing a probe of all 179 batches that
took zero 429s. **That probe was misleading**: it ran sequentially with a ~120 ms
gap, while the features phase ran at `SYNC_CONCURRENCY` (2) with no delay. The first
live run took **59 HTTP 429s** and wrote nothing for those batches.

It is the burst pattern that trips ReccoBeats, not the volume — the same shape as the
Spotify finding, and caught the same way: by running it rather than reasoning about
it.

**The recovery design absorbed it.** Because a failed batch is never recorded as
`reccobeats-notfound`, those 2,335 tracks stayed in the missing set and the next run
picked up every one, converging to exactly the predicted split. A third run made zero
requests. Failures were visible in the backdrop throughout rather than silent.

**Then it was fixed properly.** The features phase now throttles itself —
`FEATURES_CONCURRENCY` of 1 with a 120 ms inter-batch gap, matching the pattern the
probe had proven clean. It deliberately does not share the playlist pool's settings,
because the two APIs tolerate different shapes of load. Re-verified: one run,
7,135 / 7,135 records, **zero 429s, zero console errors**.

### The gap is shown, not hidden

2,199 tracks have no tempo and render as `—` in dimmed grey. Rows carry `tempo: null`
rather than `0`, so the UI can distinguish "no reading" from a real value, and the
column accessor coerces to `undefined` so unknowns sort last instead of burying
genuinely slow tracks.

**Filtering is deliberately disabled on the BPM column.** A range filter is the
obvious thing to want for planning a class, but it would silently exclude ~32 % of the
library — the exact failure class this project spent two stages eliminating. It should
return only alongside an explicit indicator of how many tracks were excluded.
