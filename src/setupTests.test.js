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
