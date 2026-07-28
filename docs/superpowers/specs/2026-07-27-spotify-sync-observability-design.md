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
