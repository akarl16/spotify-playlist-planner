import 'fake-indexeddb/auto';
import '@testing-library/jest-dom';

// Polyfill structuredClone for Node.js < 17
if (!global.structuredClone) {
    global.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}

// Each test file gets a fresh IndexedDB. Without this, databases opened in one
// test file leak into the next and version upgrades fire unpredictably.
beforeEach(() => {
    const { IDBFactory } = require('fake-indexeddb');
    global.indexedDB = new IDBFactory();
});
