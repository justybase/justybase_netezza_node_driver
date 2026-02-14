/**
 * Type conversion utilities for Netezza data types
 * Port of C# DateTypes.cs and Numeric.cs
 */

/** Time value structure */
export interface TimeValue {
    hours: number;
    minutes: number;
    seconds: number;
    microseconds: number;
    toString(): string;
}

export const POSTGRES_EPOCH_MS = Date.UTC(2000, 0, 1);

/**
 * Convert 8-byte timestamp (microseconds since 2000-01-01) to Date
 * @param data - 8 bytes little-endian
 */
export function toDateTimeFrom8Bytes(data: Buffer): Date {
    const micros = data.readBigInt64LE(0);
    const ms = Number(micros / 1000n);
    const d1 = new Date(POSTGRES_EPOCH_MS + ms);
    //const d2 =  new Date(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate(), d1.getUTCHours(), d1.getUTCMinutes(), d1.getUTCSeconds(), d1.getUTCMilliseconds());
    return d1;
}

const MS_PER_DAY = 86_400_000;

/**
 * Convert 4-byte date (days since 2000-01-01) to Date
 * @param data - 4 bytes little-endian
 */
export function toDateTimeFrom4Bytes(data: Buffer): Date {
    const days = data.readInt32LE(0);
    const ms = days * MS_PER_DAY;
    const d1 = new Date(POSTGRES_EPOCH_MS + ms);
    //const d2 = new Date(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate());
    return d1;
}

/**
 * Convert 8-byte time (microseconds) to object
 * @param data - 8 bytes little-endian
 */
export function timeRecvFloat(data: Buffer): TimeValue {
    const micros = data.readBigInt64LE(0);
    const totalSeconds = Number(micros / 1000000n);
    const remainingMicros = Number(micros % 1000000n);

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return {
        hours,
        minutes,
        seconds,
        microseconds: remainingMicros,
        toString(): string {
            const hh = String(hours).padStart(2, '0');
            const mm = String(minutes).padStart(2, '0');
            const ss = String(seconds).padStart(2, '0');
            if (remainingMicros > 0) {
                const us = String(remainingMicros).padStart(6, '0');
                return `${hh}:${mm}:${ss}.${us}`;
            }
            return `${hh}:${mm}:${ss}`;
        },
    };
}

/**
 * Parse time string "HH:MM:SS.uuuuuu" to object
 */
export function parseTimeString(str: string | null): TimeValue | null {
    if (!str) return null;
    const parts = str.split(':');
    const hours = parseInt(parts[0], 10) || 0;
    const minutes = parseInt(parts[1], 10) || 0;
    const secParts = (parts[2] || '0').split('.');
    const seconds = parseInt(secParts[0], 10) || 0;
    let microseconds = 0;
    if (secParts.length > 1) {
        // Pad to 6 digits to treat as microseconds
        microseconds = parseInt(secParts[1].substring(0, 6).padEnd(6, '0'), 10);
    }

    return {
        hours,
        minutes,
        seconds,
        microseconds,
        toString(): string {
            return str!;
        },
    };
}

/**
 * Convert interval (8-byte micros + 4-byte months) to string
 * @param data - 12 bytes
 */
export function intervalRecvFloat(data: Buffer): string {
    // micros is read but timeRecvFloat handles the conversion
    data.readBigInt64LE(0);
    const months = data.readInt32LE(8);

    const ts = timeRecvFloat(data);

    if (months === 0) {
        return ts.toString();
    }

    const years = Math.floor(months / 12);
    const remainingMonths = months % 12;

    if (years > 0) {
        return `${years} years ${remainingMonths} mons ${ts.toString()}`;
    }
    return `${remainingMonths} mons ${ts.toString()}`;
}

/**
 * Convert timetz (8-byte time + 4-byte zone offset) to string
 * @param data - 12 bytes
 * @param fldlen - field length
 */
export function timetzOutput(data: Buffer, fldlen: number): string {
    const time = timeRecvFloat(data);
    const zoneSeconds = data.readInt32LE(fldlen - 4);

    const tzSign = zoneSeconds < 0 ? '+' : '-';
    const absZone = Math.abs(zoneSeconds);
    const tzHours = Math.floor(absZone / 3600);
    const tzMinutes = Math.floor((absZone % 3600) / 60);
    const tzSeconds = absZone % 60;

    let tzStr = String(tzHours).padStart(2, '0');
    if (tzSeconds !== 0) {
        tzStr += ':' + String(tzMinutes).padStart(2, '0') + ':' + String(tzSeconds).padStart(2, '0');
    } else if (tzMinutes !== 0) {
        tzStr += ':' + String(tzMinutes).padStart(2, '0');
    }

    return `${time.toString()}${tzSign}${tzStr}`;
}

/**
 * Convert 4-byte timestamp (seconds since Unix epoch) to Date
 * Used for system tables
 * @param data - 4 bytes
 */
export function timestampRecvInt(data: Buffer): Date {
    const seconds = data.readInt32LE(0);
    return new Date(seconds * 1000);
}

// Numeric conversion constants
const MAX_NUMERIC_DIGIT_COUNT = 4;
const NUMERIC_MAX_PRECISION = 38;
const SIGN_MASK = 0x80000000;

/**
 * Convert Netezza numeric to JavaScript number or string (for high precision)
 * @param data - numeric data
 * @param prec - precision
 * @param scale - scale
 * @param digitCount - number of 32-bit digits
 */
export function getCsNumeric(data: Buffer, prec: number, scale: number, digitCount: number): number | string {
    const numParts = prec <= 9 ? 1 : prec <= 18 ? 2 : 4;

    // Read 32-bit parts
    const dataP: number[] = [];
    for (let i = 0; i < numParts; i++) {
        dataP.push(data.readUInt32LE(i * 4));
    }

    // Extend to 4 parts with sign extension
    const sign = (dataP[0] & SIGN_MASK) !== 0 ? 0xffffffff : 0;
    const varPdata = new Array<number>(MAX_NUMERIC_DIGIT_COUNT).fill(sign);

    for (let i = MAX_NUMERIC_DIGIT_COUNT - digitCount, j = 0; i < MAX_NUMERIC_DIGIT_COUNT; i++, j++) {
        varPdata[i] = dataP[j];
    }

    const isMinus = (varPdata[0] & SIGN_MASK) !== 0;

    // Negate if negative (2's complement)
    if (isMinus) {
        negate128(varPdata);
    }

    // Convert to decimal string
    const digits = new Array<number>(NUMERIC_MAX_PRECISION).fill(0);
    for (let i = 0; i < NUMERIC_MAX_PRECISION; i++) {
        digits[NUMERIC_MAX_PRECISION - i - 1] = div10_128(varPdata);
    }

    // Build result string
    let result = '';
    let leadingZero = true;

    for (let j = 0; j < NUMERIC_MAX_PRECISION; j++) {
        if (j < NUMERIC_MAX_PRECISION - scale - 1 && leadingZero && digits[j] === 0) {
            continue;
        }
        leadingZero = false;
        result += String(digits[j]);
    }

    if (result === '') result = '0';

    // Insert decimal point
    if (scale !== 0) {
        const intPart = result.slice(0, -scale) || '0';
        const decPart = result.slice(-scale).padStart(scale, '0');
        result = intPart + '.' + decPart;
    }

    if (isMinus) {
        result = '-' + result;
    }

    // Try to return as number if safe
    const num = parseFloat(result);
    if (prec <= 15 && result === String(num)) {
        return num;
    }
    return result;
}

/**
 * Divide 128-bit number by 10
 * @param numerator - 4 x 32-bit parts
 * @returns remainder
 */
function div10_128(numerator: number[]): number {
    let remainder = 0;
    for (let i = 0; i < MAX_NUMERIC_DIGIT_COUNT; i++) {
        const work = numerator[i] + remainder * 0x100000000;
        if (work !== 0) {
            numerator[i] = Math.floor(work / 10);
            remainder = work % 10;
        } else {
            numerator[i] = 0;
            remainder = 0;
        }
    }
    return remainder;
}

/**
 * Negate 128-bit number (2's complement)
 * @param data - 4 x 32-bit parts
 */
function negate128(data: number[]): void {
    // 1's complement
    for (let i = 0; i < MAX_NUMERIC_DIGIT_COUNT; i++) {
        data[i] = ~data[i] >>> 0;
    }
    // Add 1
    let carry = 1;
    for (let i = MAX_NUMERIC_DIGIT_COUNT - 1; i >= 0 && carry; i--) {
        const sum = data[i] + carry;
        data[i] = sum >>> 0;
        carry = sum > 0xffffffff ? 1 : 0;
    }
}
