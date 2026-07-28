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
