if (!global.structuredClone) {
    const v8 = require('node:v8');

    // v8.serialize/deserialize implements the structured-clone algorithm, but
    // builds the result in Node's realm — so a cloned Date fails `instanceof
    // Date` against jsdom's realm. Re-wrap realm-sensitive types in the test
    // realm while leaving everything else structurally intact.
    //
    // Cross-realm `instanceof` is unreliable here, so types are detected via
    // Object.prototype.toString. Covers Date, Map, Set, Array, and plain
    // objects, which is everything this codebase stores. TypedArrays and
    // ArrayBuffers are not handled because nothing stores them.
    const toTestRealm = (value, seen = new WeakMap()) => {
        if (value === null || typeof value !== 'object') return value;
        if (seen.has(value)) return seen.get(value);

        const tag = Object.prototype.toString.call(value);

        if (tag === '[object Date]') return new Date(value.getTime());

        if (tag === '[object Map]') {
            const out = new Map();
            seen.set(value, out);
            for (const [k, v] of value) out.set(toTestRealm(k, seen), toTestRealm(v, seen));
            return out;
        }

        if (tag === '[object Set]') {
            const out = new Set();
            seen.set(value, out);
            for (const v of value) out.add(toTestRealm(v, seen));
            return out;
        }

        if (Array.isArray(value)) {
            const out = [];
            seen.set(value, out);
            value.forEach((v, i) => { out[i] = toTestRealm(v, seen); });
            return out;
        }

        const out = {};
        seen.set(value, out);
        for (const [k, v] of Object.entries(value)) out[k] = toTestRealm(v, seen);
        return out;
    };

    global.structuredClone = (value) => toTestRealm(v8.deserialize(v8.serialize(value)));
}

import 'fake-indexeddb/auto';
import '@testing-library/jest-dom';

// Each test file gets a fresh IndexedDB. Without this, databases opened in one
// test file leak into the next and version upgrades fire unpredictably.
beforeEach(() => {
    const { IDBFactory } = require('fake-indexeddb');
    global.indexedDB = new IDBFactory();
});
