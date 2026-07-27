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

test('Date objects survive an IndexedDB round trip', async () => {
    const db = await idb.openDB('date-fidelity-check', 1, {
        upgrade(upgradeDb) {
            upgradeDb.createObjectStore('items', { keyPath: 'id' });
        }
    });

    const added_at = new Date('2026-01-15T00:00:00Z');
    await db.put('items', { id: 'a', added_at });
    const stored = await db.get('items', 'a');

    expect(stored.added_at).toBeInstanceOf(Date);
    expect(stored.added_at.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    db.close();
});

test('Map survives structuredClone as a Map, not a plain object', () => {
    const cloned = structuredClone({ m: new Map([['a', 1]]) });

    expect(cloned.m).toBeInstanceOf(Map);
    expect(cloned.m.get('a')).toBe(1);
});

test('Set survives structuredClone as a Set, not a plain object', () => {
    const cloned = structuredClone({ s: new Set([1, 2]) });

    expect(cloned.s).toBeInstanceOf(Set);
    expect(cloned.s.has(2)).toBe(true);
});

test('nested and arrayed Dates are all re-wrapped in the test realm', () => {
    const cloned = structuredClone({
        nested: { at: new Date('2026-03-01T00:00:00Z') },
        list: [{ at: new Date('2026-04-01T00:00:00Z') }]
    });

    expect(cloned.nested.at).toBeInstanceOf(Date);
    expect(cloned.list[0].at).toBeInstanceOf(Date);
    expect(cloned.list[0].at.toISOString()).toBe('2026-04-01T00:00:00.000Z');
});

test('beforeEach reset: first test writes to the shared database name', async () => {
    const db = await idb.openDB('playlist-planner', 1, {
        upgrade(upgradeDb) {
            upgradeDb.createObjectStore('leak-check', { keyPath: 'id' });
        }
    });

    await db.put('leak-check', { id: 'from-first-test' });
    expect(await db.getAll('leak-check')).toHaveLength(1);
    db.close();
});

test('beforeEach reset: the next test sees a completely fresh database', async () => {
    // If the reset were broken, the upgrade callback would not fire (the store
    // would already exist) and the record from the previous test would be here.
    let upgradeFired = false;
    const db = await idb.openDB('playlist-planner', 1, {
        upgrade(upgradeDb) {
            upgradeFired = true;
            upgradeDb.createObjectStore('leak-check', { keyPath: 'id' });
        }
    });

    expect(upgradeFired).toBe(true);
    expect(await db.getAll('leak-check')).toHaveLength(0);
    db.close();
});
