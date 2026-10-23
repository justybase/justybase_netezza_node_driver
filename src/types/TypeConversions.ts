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
export function toDateTimeFrom8Bytes(data: Buffer, offset: number = 0): Date {
    // Exact int64 microseconds / 1000 (truncated toward zero) without BigInt:
    // 2^32 = 4294967 * 1000 + 296, so micros = hi * 4294967 * 1000 + (hi * 296 + lo)
    // and every term stays a safe integer over the whole int64 range.
    const lo = data.readUInt32LE(offset);
    const hi = data.readInt32LE(offset + 4);
    const rest = hi * 296 + lo;
    const restMs = Math.floor(rest / 1000);
    let ms = hi * 4294967 + restMs;
    if (hi < 0 && rest !== restMs * 1000) ms += 1;
    return new Date(POSTGRES_EPOCH_MS + ms);
}

const MS_PER_DAY = 86_400_000;

/**
 * Convert 4-byte date (days since 2000-01-01) to Date
 * @param data - 4 bytes little-endian
 */
export function toDateTimeFrom4Bytes(data: Buffer, offset: number = 0): Date {
    const days = data.readInt32LE(offset);
    return new Date(POSTGRES_EPOCH_MS + days * MS_PER_DAY);
}

/** TimeValue decoded from the binary protocol; `toString` lives on the prototype. */
class BinaryTimeValue implements TimeValue {
    hours: number;
    minutes: number;
    seconds: number;
    microseconds: number;

    constructor(hours: number, minutes: number, seconds: number, microseconds: number) {
        this.hours = hours;
        this.minutes = minutes;
        this.seconds = seconds;
        this.microseconds = microseconds;
    }

    toString(): string {
        const hh = String(this.hours).padStart(2, '0');
        const mm = String(this.minutes).padStart(2, '0');
        const ss = String(this.seconds).padStart(2, '0');
        if (this.microseconds > 0) {
            const us = String(this.microseconds).padStart(6, '0');
            return `${hh}:${mm}:${ss}.${us}`;
        }
        return `${hh}:${mm}:${ss}`;
    }
}

/**
 * Convert 8-byte time (microseconds) to object
 * @param data - 8 bytes little-endian
 */
export function timeRecvFloat(data: Buffer, offset: number = 0): TimeValue {
    const hi = data.readInt32LE(offset + 4);
    let totalSeconds: number;
    let remainingMicros: number;
    if (hi < 0x200000 && hi >= -0x200000) {
        // |micros| < 2^53: exact in Number arithmetic (always true for a time of day).
        const micros = hi * 0x100000000 + data.readUInt32LE(offset);
        totalSeconds = Math.trunc(micros / 1_000_000) + 0; // + 0 turns -0 into 0, like BigInt
        remainingMicros = micros - totalSeconds * 1_000_000;
    } else {
        const micros = data.readBigInt64LE(offset);
        totalSeconds = Number(micros / 1000000n);
        remainingMicros = Number(micros % 1000000n);
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return new BinaryTimeValue(hours, minutes, seconds, remainingMicros);
}

/**
 * Parse time string "HH:MM:SS.uuuuuu" to object
 */
export function parseTimeString(str: string | null): TimeValue | null {
    if (!str) return null;
    const timeString = str;
    // Plain `HH:MM:SS[.ffffff]` without splitting; anything else takes the general path.
    if (timeString.length >= 8 && timeString.charCodeAt(2) === 58 && timeString.charCodeAt(5) === 58) {
        const hours = readDigits(timeString, 0, 2);
        const minutes = readDigits(timeString, 3, 2);
        const seconds = readDigits(timeString, 6, 2);
        let microseconds = 0;
        let plain = hours >= 0 && minutes >= 0 && seconds >= 0;
        if (plain && timeString.length > 8) {
            const digits = timeString.length - 9;
            plain = timeString.charCodeAt(8) === 46 && digits >= 1 && digits <= 6;
            if (plain) {
                microseconds = readDigits(timeString, 9, digits);
                plain = microseconds >= 0;
                for (let i = digits; i < 6; i++) microseconds *= 10;
            }
        }
        if (plain) {
            return {
                hours,
                minutes,
                seconds,
                microseconds,
                toString(): string {
                    return timeString;
                },
            };
        }
    }
    const parts = timeString.split(':');
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
            return timeString;
        },
    };
}

/**
 * Convert interval (8-byte micros + 4-byte months) to string
 * @param data - 12 bytes
 */
export function intervalRecvFloat(data: Buffer, offset: number = 0): string {
    const months = data.readInt32LE(offset + 8);

    const ts = timeRecvFloat(data, offset);

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
export function timetzOutput(data: Buffer, fldlen: number, offset: number = 0): string {
    const time = timeRecvFloat(data, offset);
    const zoneSeconds = data.readInt32LE(offset + fldlen - 4);

    const tzSign = zoneSeconds < 0 ? '+' : '-';
    const absZone = Math.abs(zoneSeconds);
    const tzHours = Math.floor(absZone / 3600);
    const tzMinutes = Math.floor((absZone % 3600) / 60);
    const tzSeconds = absZone % 60;

    let tzStr = String(tzHours).padStart(2, '0');
    if (tzSeconds !== 0) {
        tzStr += `:${String(tzMinutes).padStart(2, '0')}:${String(tzSeconds).padStart(2, '0')}`;
    } else if (tzMinutes !== 0) {
        tzStr += `:${String(tzMinutes).padStart(2, '0')}`;
    }

    return `${time.toString()}${tzSign}${tzStr}`;
}

/**
 * Convert 4-byte timestamp (seconds since Unix epoch) to Date
 * Used for system tables
 * @param data - 4 bytes
 */
export function timestampRecvInt(data: Buffer, offset: number = 0): Date {
    const seconds = data.readInt32LE(offset);
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
    if (i < end && data[i] === 45) {
        neg = true;
        i++;
    }
    while (i < end) {
        val = val * 10 + (data[i] - 48);
        i++;
    }
    return neg ? -val : val;
}

function parseBigIntFromBuffer(data: Buffer, offset: number, len: number): bigint {
    // Up to 15 digits fit a double exactly: one BigInt instead of one per digit.
    if (len <= 16) {
        let i = offset;
        const end = offset + len;
        const neg = i < end && data[i] === 45;
        if (neg) i++;
        let num = 0;
        let digits = 0;
        for (; i < end; i++, digits++) {
            const d = data[i] - 48;
            if (d < 0 || d > 9) break;
            num = num * 10 + d;
        }
        if (i === end && digits <= 15) return BigInt(neg ? -num : num);
    }
    let val = 0n;
    let neg = false;
    let i = offset;
    const end = offset + len;
    if (i < end && data[i] === 45) {
        neg = true;
        i++;
    }
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
    return parseNumericTextWithPrecision(value, parseNumericTypeModifier(typeMod).precision);
}

function parseNumericTextWithPrecision(value: string, precision: number): number | string {
    const trimmed = value.trim();
    const numeric = Number(trimmed);

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

/** Value of `len` ASCII digits at `pos`, or -1 if any is not a digit. */
function readDigits(text: string, pos: number, len: number): number {
    let value = 0;
    for (let i = pos; i < pos + len; i++) {
        const d = text.charCodeAt(i) - 48;
        if (d < 0 || d > 9) return -1;
        value = value * 10 + d;
    }
    return value;
}

/**
 * Milliseconds of a plain `YYYY-MM-DD` date at `pos`, or NaN when the text is
 * not in the range where `Date.UTC` provably matches the ISO parser
 * (years 100+, month 1-12, day 1-31; both roll day overflow forward).
 */
function plainDateMs(text: string, pos: number): number {
    if (text.charCodeAt(pos + 4) !== 45 || text.charCodeAt(pos + 7) !== 45) return Number.NaN;
    const year = readDigits(text, pos, 4);
    const month = readDigits(text, pos + 5, 2);
    const day = readDigits(text, pos + 8, 2);
    if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31) return Number.NaN;
    return Date.UTC(year, month - 1, day);
}

function parseDateText(value: string): Date {
    if (value.length === 10) {
        const ms = plainDateMs(value, 0);
        if (!Number.isNaN(ms)) return new Date(ms);
    }
    return new Date(`${value.trim()}T00:00:00.000Z`);
}

/**
 * `YYYY-MM-DD HH:MM:SS[.f+][+HH[:MM]|-HH[:MM]]` without regex or string
 * building; NaN sends anything else to the general parser.
 */
function plainTimestampMs(text: string): number {
    const length = text.length;
    if (length < 19) return Number.NaN;
    const sep = text.charCodeAt(10);
    if ((sep !== 32 && sep !== 84) || text.charCodeAt(13) !== 58 || text.charCodeAt(16) !== 58) return Number.NaN;
    const dateMs = plainDateMs(text, 0);
    const hours = readDigits(text, 11, 2);
    const minutes = readDigits(text, 14, 2);
    const seconds = readDigits(text, 17, 2);
    if (Number.isNaN(dateMs) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
        return Number.NaN;
    }
    let pos = 19;
    let millis = 0;
    if (pos < length && text.charCodeAt(pos) === 46) {
        pos++;
        const fractionStart = pos;
        while (pos < length) {
            const d = text.charCodeAt(pos) - 48;
            if (d < 0 || d > 9) break;
            // Truncated to milliseconds, like the general parser.
            if (pos - fractionStart < 3) millis = millis * 10 + d;
            pos++;
        }
        if (pos === fractionStart) return Number.NaN;
        for (let i = Math.min(pos - fractionStart, 3); i < 3; i++) millis *= 10;
    }
    let zoneMs = 0;
    if (pos < length) {
        const sign = text.charCodeAt(pos);
        if (sign !== 43 && sign !== 45) return Number.NaN;
        const zoneHours = readDigits(text, pos + 1, 2);
        let zoneMinutes = 0;
        if (pos + 3 === length) {
            pos += 3;
        } else {
            const minutesAt = text.charCodeAt(pos + 3) === 58 ? pos + 4 : pos + 3;
            zoneMinutes = readDigits(text, minutesAt, 2);
            pos = minutesAt + 2;
        }
        if (pos !== length || zoneHours < 0 || zoneHours > 23 || zoneMinutes < 0 || zoneMinutes > 59) {
            return Number.NaN;
        }
        zoneMs = (zoneHours * 60 + zoneMinutes) * 60_000 * (sign === 43 ? 1 : -1);
    }
    return dateMs + ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis - zoneMs;
}

function normalizeTimestampText(value: string): string | null {
    const trimmed = value.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return `${trimmed}T00:00:00.000Z`;
    }

    const match = trimmed.match(
        /^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)?(?:([+-])([0-9]{2})(?::?([0-9]{2}))?)?$/
    );
    if (!match) {
        return null;
    }

    const [, datePart, timePart, fraction = '', sign, zoneHours, zoneMinutes] = match;
    const milliseconds = fraction ? `.${fraction.slice(1).padEnd(3, '0').slice(0, 3)}` : '';
    const timezone = sign ? `${sign}${zoneHours}:${zoneMinutes || '00'}` : 'Z';
    return `${datePart}T${timePart}${milliseconds}${timezone}`;
}

function parseTimestampText(value: string): Date {
    const ms = plainTimestampMs(value);
    if (!Number.isNaN(ms)) return new Date(ms);
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
        case 1700: {
            const { precision } = parseNumericTypeModifier(typeMod);
            return (value: string) => parseNumericTextWithPrecision(value, precision);
        }
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

// Scratch for wide values as 16-bit limbs (most significant first): a
// remainder below 1e9 times 2^16 plus a limb stays far below 2^53, so the
// base-1e9 long division is exact in Number arithmetic.
const WIDE_LIMBS = new Uint32Array(16);

const NINE_ZEROS = '000000000';

/** Inserts the decimal point into a short (flat) digit chunk when the scale boundary falls inside it. */
function placeDecimalPoint(chunk: string, emitted: number, scale: number): string {
    const fraction = scale - emitted;
    if (fraction <= 0 || fraction > chunk.length) return chunk;
    const split = chunk.length - fraction;
    return `${split === 0 ? '' : chunk.slice(0, split)}.${chunk.slice(split)}`;
}

/**
 * Exact decimal text of any word count without BigInt: base-1e9 long division
 * over 16-bit limbs. The decimal point is placed while the 9-digit chunks are
 * assembled, so the long result string is never sliced (and flattened) again.
 */
function formatWideNumeric(data: Buffer, partCount: number, offset: number, scale: number): string {
    const n = partCount * 2;
    const limbs = n <= WIDE_LIMBS.length ? WIDE_LIMBS : new Uint32Array(n);
    for (let i = 0; i < partCount; i++) {
        const word = data.readUInt32LE(offset + i * 4);
        limbs[2 * i] = word >>> 16;
        limbs[2 * i + 1] = word & 0xffff;
    }
    const isMinus = (limbs[0] & 0x8000) !== 0;
    if (isMinus) {
        // Two's complement negation: invert, then add one from the least significant limb.
        let carry = 1;
        for (let i = n - 1; i >= 0; i--) {
            const v = (~limbs[i] & 0xffff) + carry;
            limbs[i] = v & 0xffff;
            carry = v >>> 16;
        }
    }
    let first = 0;
    while (first < n && limbs[first] === 0) first++;
    let text = '';
    let emitted = 0;
    while (first < n) {
        let rem = 0;
        for (let i = first; i < n; i++) {
            const cur = rem * 65536 + limbs[i];
            const q = (cur / 1e9) | 0; // < 65536
            limbs[i] = q;
            rem = cur - q * 1e9;
        }
        while (first < n && limbs[first] === 0) first++;
        let chunk = `${rem}`;
        if (first < n && chunk.length < 9) chunk = NINE_ZEROS.slice(chunk.length) + chunk;
        text = placeDecimalPoint(chunk, emitted, scale) + text;
        emitted += chunk.length;
    }
    if (emitted === 0) {
        text = '0';
        emitted = 1;
    }
    if (scale >= emitted) {
        // No integer digits were produced: "0." plus the missing leading fraction zeros.
        text = `0.${'0'.repeat(scale - emitted)}${text.charCodeAt(0) === 46 ? text.slice(1) : text}`;
    }
    return isMinus ? `-${text}` : text;
}

const POW10: readonly number[] = Array.from({ length: 23 }, (_, i) => 10 ** i);
const TWO_POW_32 = 0x100000000;

/** Formats an unscaled integer as exact decimal text with `scale` fraction digits. */
function formatNumeric(digits: string, isMinus: boolean, scale: number): string {
    let result = digits;
    if (scale !== 0) {
        const padded = result.length > scale ? result : result.padStart(scale + 1, '0');
        const decimalStart = padded.length - scale;
        result = `${padded.slice(0, decimalStart)}.${padded.slice(decimalStart)}`;
    }
    return isMinus ? `-${result}` : result;
}

/**
 * Reads the unscaled value when it is a safe integer, otherwise returns NaN.
 * Words are 32-bit little-endian, most significant word first, two's complement.
 */
function readSafeUnscaled(data: Buffer, partCount: number, offset: number): number {
    if (partCount === 1) return data.readInt32LE(offset);
    // The two least significant words; every higher word must be pure sign extension.
    const hiOffset = offset + (partCount - 2) * 4;
    const hi = data.readInt32LE(hiOffset);
    const lo = data.readUInt32LE(hiOffset + 4);
    const extension = hi < 0 ? -1 : 0;
    for (let i = 0; i < partCount - 2; i++) {
        if (data.readInt32LE(offset + i * 4) !== extension) return Number.NaN;
    }
    // |hi| < 2^21 keeps hi * 2^32 + lo within ±2^53.
    if (hi >= 0x200000 || hi < -0x200000) return Number.NaN;
    return hi * TWO_POW_32 + lo;
}

/**
 * Convert Netezza numeric to JavaScript number or string (for high precision)
 *
 * A number is returned only for precision <= 15 when the exact decimal text
 * survives a `parseFloat`/`String` round trip (no trailing fraction zero, not
 * printed in exponent form); otherwise the exact decimal text is returned.
 * That rule is evaluated arithmetically for safe-integer values, without
 * building or parsing text; wider values are converted by exact base-1e9
 * long division instead of BigInt.
 *
 * @param data - numeric data
 * @param prec - precision
 * @param scale - scale
 * @param digitCount - number of 32-bit digits
 */
export function getCsNumeric(
    data: Buffer,
    prec: number,
    scale: number,
    digitCount: number,
    offset: number = 0
): number | string {
    const partCount = digitCount > 0 ? digitCount : prec <= 9 ? 1 : prec <= 18 ? 2 : 4;

    const unscaled = readSafeUnscaled(data, partCount, offset);
    if (!Number.isNaN(unscaled)) {
        const abs = unscaled < 0 ? -unscaled : unscaled;
        if (prec <= 15 && abs < 1e15) {
            // At most 15 significant digits: the division is correctly rounded,
            // so it equals parseFloat of the exact text, and String() of it
            // reproduces that text unless it has a trailing fraction zero or
            // is below 1e-6 (exponent notation).
            if (scale === 0) return unscaled;
            if (abs % 10 !== 0 && scale < POW10.length) {
                const value = unscaled / POW10[scale];
                if (abs >= POW10[scale] / 1e6) return value;
            }
            return formatNumeric(String(abs), unscaled < 0, scale);
        }
        const result = formatNumeric(String(abs), unscaled < 0, scale);
        if (prec <= 15) {
            const num = parseFloat(result);
            if (result === String(num)) return num;
        }
        return result;
    }

    const result = formatWideNumeric(data, partCount, offset, scale);
    if (prec <= 15) {
        const num = parseFloat(result);
        if (result === String(num)) return num;
    }
    return result;
}
