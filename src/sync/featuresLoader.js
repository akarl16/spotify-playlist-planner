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
