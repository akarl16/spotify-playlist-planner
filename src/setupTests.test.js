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
