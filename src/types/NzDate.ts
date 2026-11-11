/**
 * Immutable Date subclasses returned by the driver.
 *
 * Netezza results often repeat the same DATE/TIMESTAMP thousands of times.
 * Sharing a plain `Date` would be unsafe because callers can mutate it
 * (`row.date.setHours(...)` would corrupt every row that shares the object).
 * These subclasses keep the normal Date read API and `instanceof Date`, but
 * throw on every mutator, so the per-column value cache can safely return the
 * same object for repeated values.
 *
 * Callers who need a mutable copy can use `new Date(row.date)`.
 */

const IMMUTABLE = 'NzDate is immutable; use new Date(value) for a mutable copy';

/** Immutable DATE value. `instanceof Date` remains true. */
export class NzDate extends Date {
    constructor(ms: number, freeze: boolean = true) {
        super(ms);
        if (freeze) Object.freeze(this);
    }

    override setTime(_time: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setMilliseconds(_ms: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setSeconds(_sec: number, _ms?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setMinutes(_min: number, _sec?: number, _ms?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setHours(_hour: number, _min?: number, _sec?: number, _ms?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setDate(_date: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setMonth(_month: number, _date?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setFullYear(_year: number, _month?: number, _date?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setUTCMilliseconds(_ms: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setUTCSeconds(_sec: number, _ms?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setUTCMinutes(_min: number, _sec?: number, _ms?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setUTCHours(_hour: number, _min?: number, _sec?: number, _ms?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setUTCDate(_date: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setUTCMonth(_month: number, _date?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    override setUTCFullYear(_year: number, _month?: number, _date?: number): never {
        throw new TypeError(IMMUTABLE);
    }
    setYear(_year: number): never {
        throw new TypeError(IMMUTABLE);
    }
}

/** Immutable TIMESTAMP value, preserving the wire microseconds. */
export class NzTimestamp extends NzDate {
    /** Microsecond fraction of the second (0..999999); non-enumerable. */
    declare readonly microseconds: number;

    constructor(ms: number, microseconds: number) {
        super(ms, false);
        Object.defineProperty(this, 'microseconds', {
            value: microseconds,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        Object.freeze(this);
    }
}

/** Immutable TIME value with the driver's existing `toString()` shape. */
export class NzTime {
    readonly hours: number;
    readonly minutes: number;
    readonly seconds: number;
    readonly microseconds: number;

    constructor(hours: number, minutes: number, seconds: number, microseconds: number, text?: string) {
        this.hours = hours;
        this.minutes = minutes;
        this.seconds = seconds;
        this.microseconds = microseconds;
        const rendered = text ?? formatTime(hours, minutes, seconds, microseconds);
        // Keep the historical plain-object JSON/keys shape: `text` is
        // internal and `toString` stays an own enumerable property.
        Object.defineProperty(this, 'text', { value: rendered, enumerable: false });
        Object.defineProperty(this, 'toString', { value: () => rendered, enumerable: true });
        Object.freeze(this);
    }

    toString(): string {
        return (this as unknown as { text: string }).text;
    }
}

function formatTime(hours: number, minutes: number, seconds: number, microseconds: number): string {
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    if (microseconds > 0) {
        const us = String(microseconds).padStart(6, '0');
        return `${hh}:${mm}:${ss}.${us}`;
    }
    return `${hh}:${mm}:${ss}`;
}
