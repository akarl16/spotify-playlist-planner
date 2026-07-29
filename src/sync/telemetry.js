const PHASES = [
    { key: 'headers', label: 'Playlist headers' },
    { key: 'library', label: 'Library playlists' },
    { key: 'class', label: 'Class playlists' },
    { key: 'repair', label: 'Repair incomplete playlists' },
    { key: 'features', label: 'Track tempo' }
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
        incomplete: [],
        fatalError: null
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
            // A cache hit advances progress and counts toward tracks cached, but is
            // deliberately kept out of the feed — with hundreds of already-synced
            // playlists it would drown the rows describing actual work.
            if (event.cached) return withStats;
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

        case 'sync:error':
            return {
                ...state,
                running: false,
                fatalError: {
                    kind: event.cause?.kind ?? 'http',
                    status: event.cause?.status ?? 0,
                    message: event.message ?? 'Sync failed'
                }
            };

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
