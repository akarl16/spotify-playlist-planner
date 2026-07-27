// Jest's jsdom sandbox does not expose structuredClone even on Node 17+, but
// fake-indexeddb needs it. v8.serialize/deserialize implements the same
// structured-clone algorithm, so Date, Map, and Set survive the round trip —
// a JSON-based polyfill would silently turn every stored Date into a string.
if (!global.structuredClone) {
    const v8 = require('node:v8');

    const fixRealmDateObjects = (value) => {
        // v8 deserialization may create Date objects that don't pass jsdom's instanceof check
        // Fix them by recreating in the current realm
        if (Object.prototype.toString.call(value) === '[object Date]' &&
            !(value instanceof Date)) {
            return new Date(value.getTime());
        }
        // Recursively fix nested objects
        if (value !== null && typeof value === 'object') {
            if (Array.isArray(value)) {
                return value.map(fixRealmDateObjects);
            }
            const result = {};
            for (const key in value) {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    result[key] = fixRealmDateObjects(value[key]);
                }
            }
            return result;
        }
        return value;
    };

    global.structuredClone = (value) => {
        const deserialized = v8.deserialize(v8.serialize(value));
        return fixRealmDateObjects(deserialized);
    };
}

import 'fake-indexeddb/auto';
import '@testing-library/jest-dom';

// Each test file gets a fresh IndexedDB. Without this, databases opened in one
// test file leak into the next and version upgrades fire unpredictably.
beforeEach(() => {
    const { IDBFactory } = require('fake-indexeddb');
    global.indexedDB = new IDBFactory();
});
