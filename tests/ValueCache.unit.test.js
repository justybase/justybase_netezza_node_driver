'use strict';

const { ValueCache } = require('../dist/cjs/utils/ValueCache');
const { NzDate, NzTimestamp, NzTime } = require('../dist/cjs/types/NzDate');

describe('ValueCache', () => {
    test('repeated bytes return the same immutable value', () => {
        const diag = {
            valueCacheHits: 0,
            valueCacheMisses: 0,
            valueCacheInsertions: 0,
            valueCacheRejected: 0,
            valueCacheDisabledColumns: 0,
        };
        const cache = new ValueCache(diag, 16, 64, 100);
        const key = Buffer.from('alpha', 'latin1');
        const first = cache.getOrCreate(key, 0, key.length, () => 'alpha');
        const second = cache.getOrCreate(key, 0, key.length, () => {
            throw new Error('decoded a cached value');
        });
        expect(second).toBe(first);
        expect(diag.valueCacheHits).toBe(1);
        expect(diag.valueCacheInsertions).toBe(1);
    });

    test('long keys are rejected and remembered for the last-hit path', () => {
        const diag = {
            valueCacheHits: 0,
            valueCacheMisses: 0,
            valueCacheInsertions: 0,
            valueCacheRejected: 0,
            valueCacheDisabledColumns: 0,
        };
        const cache = new ValueCache(diag, 8, 4, 100);
        const key = Buffer.from('abcdef', 'latin1');
        const first = cache.getOrCreate(key, 0, key.length, () => 'abcdef');
        const second = cache.getOrCreate(key, 0, key.length, () => 'abcdef');
        expect(second).toBe(first);
        expect(cache.size).toBe(0);
        expect(diag.valueCacheRejected).toBe(2);
    });

    test('high-cardinality columns disable themselves after the probe', () => {
        const diag = {
            valueCacheHits: 0,
            valueCacheMisses: 0,
            valueCacheInsertions: 0,
            valueCacheRejected: 0,
            valueCacheDisabledColumns: 0,
        };
        const cache = new ValueCache(diag, 32, 64, 8);
        // The probe is explicit here, so the default 8192 does not apply.

        for (let i = 0; i < 8; i++) {
            const key = Buffer.from(String(i), 'latin1');
            cache.getOrCreate(key, 0, key.length, () => String(i));
        }
        expect(cache.isEnabled).toBe(false);
        expect(cache.size).toBe(0);
        expect(diag.valueCacheDisabledColumns).toBe(1);
    });

    test('keys longer than the byte-loop threshold still match exactly', () => {
        const diag = {
            valueCacheHits: 0,
            valueCacheMisses: 0,
            valueCacheInsertions: 0,
            valueCacheRejected: 0,
            valueCacheDisabledColumns: 0,
        };
        const cache = new ValueCache(diag, 16, 64, 100);
        const key = Buffer.from('abcdefghijklmnopqr', 'latin1');
        const nearMiss = Buffer.from('abcdefghijklmnopqX', 'latin1');
        const first = cache.getOrCreate(key, 0, key.length, () => 'long');
        const second = cache.getOrCreate(key, 0, key.length, () => {
            throw new Error('decoded a cached value');
        });
        expect(second).toBe(first);
        expect(cache.get(nearMiss, 0, nearMiss.length)).toBeUndefined();
        expect(diag.valueCacheHits).toBe(1);
        expect(diag.valueCacheMisses).toBe(2);
    });

    test('bounds the number of entries', () => {
        const cache = new ValueCache(undefined, 2, 64, 100);
        cache.getOrCreate(Buffer.from('a'), 0, 1, () => 'a');
        cache.getOrCreate(Buffer.from('b'), 0, 1, () => 'b');
        cache.getOrCreate(Buffer.from('c'), 0, 1, () => 'c');
        expect(cache.size).toBe(2);
    });
});

describe('immutable temporal values', () => {
    test('NzDate keeps the Date read API but rejects mutation', () => {
        const value = new NzDate(Date.UTC(2024, 0, 2));
        expect(value).toBeInstanceOf(Date);
        expect(value.toISOString()).toBe('2024-01-02T00:00:00.000Z');
        expect(() => value.setUTCHours(1)).toThrow(TypeError);
    });

    test('NzTimestamp preserves microseconds and rejects mutation', () => {
        const value = new NzTimestamp(Date.UTC(2024, 0, 2, 3, 4, 5, 6), 123456);
        expect(value).toBeInstanceOf(Date);
        expect(value.microseconds).toBe(123456);
        // Same own-property shape as before: microseconds stays hidden.
        expect(Object.keys(value)).not.toContain('microseconds');
        expect(value.propertyIsEnumerable('microseconds')).toBe(false);
        expect(() => value.setTime(0)).toThrow(TypeError);
    });

    test('NzTime is immutable and keeps the original text', () => {
        const value = new NzTime(1, 2, 3, 4, '01:02:03.000004');
        expect(value.toString()).toBe('01:02:03.000004');
        expect(Object.isFrozen(value)).toBe(true);
    });
});
