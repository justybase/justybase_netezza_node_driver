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

const TYPE_MOD_OFFSET = 16;
type TextValueParser = (value: string) => unknown;
type TextBufferParser = (data: Buffer, offset: number, len: number) => unknown;

function parseIntFromBuffer(data: Buffer, offset: number, len: number): number {
    let val = 0;
    let neg = false;
    let i = offset;
    const end = offset + len;
    if (i < end && data[i] === 45) { neg = true; i++; }
    while (i < end) {
        val = val * 10 + (data[i] - 48);
        i++;
    }
    return neg ? -val : val;
}

function parseBigIntFromBuffer(data: Buffer, offset: number, len: number): bigint {
    let val = 0n;
    let neg = false;
    let i = offset;
    const end = offset + len;
    if (i < end && data[i] === 45) { neg = true; i++; }
    while (i < end) {
        val = val * 10n + BigInt(data[i] - 48);
        i++;
    }
    return neg ? -val : val;
}

function parseBooleanFromBuffer(data: Buffer, offset: number): boolean {
    const b = data[offset];
    return b === 116 || b === 49;
}

export function createTextBufferParser(typeOid: number, _typeMod: number = -1): TextBufferParser | null {
    switch (typeOid) {
        case 16:
            return (data, offset) => parseBooleanFromBuffer(data, offset);
        case 20:
            return parseBigIntFromBuffer;
        case 21:
        case 23:
        case 26:
        case 2500:
            return parseIntFromBuffer;
        case 700:
        case 701:
            return (data, offset, len) => Number(data.toString('ascii', offset, offset + len));
        default:
            return null;
    }
}

function parseBigIntText(value: string): bigint {
    return BigInt(value.trim());
}

function parseNumberText(value: string): number {
    return Number(value.trim());
}

function parseTimeText(value: string): TimeValue | null {
    return parseTimeString(value.trim());
}

function passthroughText(value: string): string {
    return value;
}

function parseBooleanText(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return normalized === 't' || normalized === 'true' || normalized === '1';
}

function parseNumericTypeModifier(typeMod: number): { precision: number; scale: number } {
    if (typeMod > TYPE_MOD_OFFSET) {
        const normalized = typeMod - TYPE_MOD_OFFSET;
        return {
            precision: normalized >> 16,
            scale: normalized & 0xffff,
        };
    }
    return { precision: 0, scale: 0 };
}

function parseNumericText(value: string, typeMod: number): number | string {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    const { precision } = parseNumericTypeModifier(typeMod);

    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
        if (precision === 0) {
            if (/^-?\d+(\.\d+)?$/.test(trimmed) && trimmed === String(numeric)) {
                return numeric;
            }
        } else if (precision <= 15 && trimmed === String(numeric)) {
            return numeric;
        }
    }

    return trimmed;
}

function parseDateText(value: string): Date {
    return new Date(`${value.trim()}T00:00:00.000Z`);
}

function normalizeTimestampText(value: string): string | null {
    const trimmed = value.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return `${trimmed}T00:00:00.000Z`;
    }

    const match = trimmed.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)?(?:([+-])([0-9]{2})(?::?([0-9]{2}))?)?$/);
    if (!match) {
        return null;
    }

    const [, datePart, timePart, fraction = '', sign, zoneHours, zoneMinutes] = match;
    const milliseconds = fraction ? `.${fraction.slice(1).padEnd(3, '0').slice(0, 3)}` : '';
    const timezone = sign ? `${sign}${zoneHours}:${zoneMinutes || '00'}` : 'Z';
    return `${datePart}T${timePart}${milliseconds}${timezone}`;
}

function parseTimestampText(value: string): Date {
    const normalized = normalizeTimestampText(value);
    if (normalized) {
        return new Date(normalized);
    }

    const trimmed = value.trim();
    const hasTimezone = /(?:[zZ]|[+-][0-9]{2}(?::?[0-9]{2})?)$/.test(trimmed);
    return new Date(`${trimmed.replace(' ', 'T')}${hasTimezone ? '' : 'Z'}`);
}

export function createTextValueParser(typeOid: number, typeMod: number = -1): TextValueParser {
    switch (typeOid) {
        case 16:
            return parseBooleanText;
        case 20:
            return parseBigIntText;
        case 21:
        case 23:
        case 26:
        case 700:
        case 701:
        case 2500:
            return parseNumberText;
        case 702:
        case 1114:
        case 1184:
            return parseTimestampText;
        case 1082:
            return parseDateText;
        case 1083:
            return parseTimeText;
        case 1186:
        case 1266:
            return passthroughText;
        case 1700:
            return (value: string) => parseNumericText(value, typeMod);
        default:
            return passthroughText;
    }
}

export function parseTextValue(value: string, typeOid: number, typeMod: number = -1): unknown {
    switch (typeOid) {
        case 16:
            return parseBooleanText(value);
        case 20:
            return parseBigIntText(value);
        case 21:
        case 23:
        case 26:
        case 700:
        case 701:
        case 2500:
            return parseNumberText(value);
        case 702:
        case 1114:
        case 1184:
            return parseTimestampText(value);
        case 1082:
            return parseDateText(value);
        case 1083:
            return parseTimeText(value);
        case 1186:
        case 1266:
            return value;
        case 1700:
            return parseNumericText(value, typeMod);
        default:
            return value;
    }
}

const NUMERIC_PART_BITS = 32n;

function readSignedNumericBigInt(data: Buffer, partCount: number): bigint {
    if (partCount <= 0) {
        return 0n;
    }

    let raw = 0n;
    for (let i = 0; i < partCount; i++) {
        raw = (raw << NUMERIC_PART_BITS) | BigInt(data.readUInt32LE(i * 4));
    }

    const totalBits = BigInt(partCount) * NUMERIC_PART_BITS;
    const signBit = 1n << (totalBits - 1n);
    if ((raw & signBit) !== 0n) {
        raw -= 1n << totalBits;
    }

    return raw;
}

/**
 * Convert Netezza numeric to JavaScript number or string (for high precision)
 * @param data - numeric data
 * @param prec - precision
 * @param scale - scale
 * @param digitCount - number of 32-bit digits
 */
export function getCsNumeric(data: Buffer, prec: number, scale: number, digitCount: number): number | string {
    const partCount = digitCount > 0 ? digitCount : prec <= 9 ? 1 : prec <= 18 ? 2 : 4;
    let unscaledValue = readSignedNumericBigInt(data, partCount);
    const isMinus = unscaledValue < 0n;

    if (isMinus) {
        unscaledValue = -unscaledValue;
    }

    let result = unscaledValue.toString();

    // Insert decimal point
    if (scale !== 0) {
        const padded = result.padStart(scale + 1, '0');
        const decimalStart = padded.length - scale;
        result = padded.slice(0, decimalStart) + '.' + padded.slice(decimalStart);
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
