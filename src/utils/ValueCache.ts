/**
 * Per-result-set, per-column value deduplication.
 *
 * The cache is keyed by the exact wire bytes of a cell, so a hit returns the
 * already decoded value without decoding or allocating. It only stores
 * immutable values (strings, numbers, bigint, NzDate/NzTimestamp/NzTime).
 *
 * Bounded per column, with a last-value fast path for grouped rows. A column
 * with almost no repetition disables itself after the probe to avoid paying
 * hash/lock cost on high-cardinality data.
 */

export const DEFAULT_MAX_ENTRIES = 2048;
export const DEFAULT_MAX_KEY_BYTES = 64;
export const DEFAULT_PROBE_LOOKUPS = 8192;

interface Entry<T> {
    key: Buffer;
    value: T;
}

/** FNV-1a over a byte range; no temporary string or Buffer allocation. */
function hashBytes(buf: Buffer, start: number, end: number): number {
    let hash = 0x811c9dc5;
    for (let i = start; i < end; i++) {
        hash ^= buf[i];
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * Byte-exact comparison. Values in this cache are short (keys are capped), and
 * a direct byte loop is faster than the native `Buffer.compare` call for them.
 */
function keyEquals(buf: Buffer, start: number, end: number, key: Buffer): boolean {
    const length = end - start;
    if (key.length !== length) return false;
    if (length <= 16) {
        for (let i = 0; i < length; i++) {
            if (buf[start + i] !== key[i]) return false;
        }
        return true;
    }
    return buf.compare(key, 0, length, start, end) === 0;
}

export class ValueCache<T> {
    private readonly buckets = new Map<number, Entry<T>[]>();
    private readonly maxEntries: number;
    private readonly maxKeyBytes: number;
    private readonly probeLookups: number;
    private readonly diag?: Record<string, number>;

    private entries = 0;
    private lookups = 0;
    private hits = 0;
    private enabled = true;
    private lastKey: Buffer | null = null;
    private lastValue: T | undefined;

    constructor(
        diag?: Record<string, number>,
        maxEntries: number = DEFAULT_MAX_ENTRIES,
        maxKeyBytes: number = DEFAULT_MAX_KEY_BYTES,
        probeLookups: number = DEFAULT_PROBE_LOOKUPS
    ) {
        this.diag = diag;
        this.maxEntries = maxEntries;
        this.maxKeyBytes = maxKeyBytes;
        this.probeLookups = probeLookups;
    }

    get size(): number {
        return this.entries;
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    /** Return a cached value or `undefined` on a miss. */
    get(buf: Buffer, start: number, end: number): T | undefined {
        if (!this.enabled) return undefined;
        const length = end - start;
        if (length > this.maxKeyBytes) {
            this.recordMiss();
            return undefined;
        }

        const last = this.lastKey;
        if (last !== null && keyEquals(buf, start, end, last)) {
            this.recordHit();
            return this.lastValue;
        }

        const hash = hashBytes(buf, start, end);
        const bucket = this.buckets.get(hash);
        if (bucket !== undefined) {
            for (let i = 0; i < bucket.length; i++) {
                const entry = bucket[i];
                if (keyEquals(buf, start, end, entry.key)) {
                    this.lastKey = entry.key;
                    this.lastValue = entry.value;
                    this.recordHit();
                    return entry.value;
                }
            }
        }
        this.recordMiss();
        return undefined;
    }

    /** Store a decoded value. Rejected values are still remembered for the last-hit path. */
    set(buf: Buffer, start: number, end: number, value: T): void {
        if (!this.enabled) return;
        const length = end - start;
        if (length > this.maxKeyBytes) {
            this.recordRejected();
            return;
        }

        // Keep the last-hit path useful even when the bounded map is full.
        const key = Buffer.from(buf.subarray(start, end));
        this.lastKey = key;
        this.lastValue = value;

        const hash = hashBytes(buf, start, end);
        const bucket = this.buckets.get(hash);
        if (bucket !== undefined) {
            for (let i = 0; i < bucket.length; i++) {
                const entry = bucket[i];
                if (entry.key.length === length && entry.key.equals(key)) {
                    entry.value = value;
                    return;
                }
            }
        }
        if (this.entries >= this.maxEntries) {
            this.recordRejected();
            return;
        }
        if (bucket === undefined) {
            this.buckets.set(hash, [{ key, value }]);
        } else {
            bucket.push({ key, value });
        }
        this.entries++;
        if (this.diag) this.diag.valueCacheInsertions++;
    }

    /** Return a cached value or decode, store, and return a new one. */
    getOrCreate(buf: Buffer, start: number, end: number, create: () => T): T {
        const hit = this.get(buf, start, end);
        if (hit !== undefined) return hit;
        const value = create();
        this.set(buf, start, end, value);
        return value;
    }

    private recordHit(): void {
        this.hits++;
        if (this.diag) this.diag.valueCacheHits++;
        this.probe();
    }

    private recordMiss(): void {
        if (this.diag) this.diag.valueCacheMisses++;
        this.probe();
    }

    private probe(): void {
        this.lookups++;
        if (this.lookups !== this.probeLookups) return;
        if (this.hits * 50 >= this.lookups) return;
        this.enabled = false;
        this.buckets.clear();
        this.entries = 0;
        this.lastKey = null;
        this.lastValue = undefined;
        if (this.diag) this.diag.valueCacheDisabledColumns++;
    }

    private recordRejected(): void {
        if (this.diag) this.diag.valueCacheRejected++;
    }
}
