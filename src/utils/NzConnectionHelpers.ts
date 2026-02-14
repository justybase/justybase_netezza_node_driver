/**
 * Helper functions for parsing Netezza data types
 * Port of C# NzConnectionHelpers.cs
 */

export const CLIENT_ENCODING = 'utf8';
export const CHAR_VARCHAR_ENCODING = 'latin1';

/** Time value structure */
export interface TimeValue {
    hours: number;
    minutes: number;
    seconds: number;
    microseconds: number;
    toString(): string;
}

/**
 * Parse text from buffer
 */
export function textRecv(data: Buffer, offset: number, length: number): string {
    if (length + offset > data.length) {
        length = data.length - offset;
    }
    return data.toString(CLIENT_ENCODING as BufferEncoding, offset, offset + length);
}

/**
 * Parse Latin1/ASCII text from buffer
 */
export function textRecvLatin1(data: Buffer, offset: number, length: number): string {
    if (length + offset > data.length) {
        length = data.length - offset;
    }
    return data.toString(CHAR_VARCHAR_ENCODING as BufferEncoding, offset, offset + length);
}

/**
 * Parse bytea/binary data as hex string
 */
export function byteaRecv(data: Buffer, offset: number, length: number): string {
    return data.toString('ascii', offset, offset + length);
}

/**
 * Parse boolean from text ('t' or 'f')
 */
export function boolRecv(data: Buffer, offset: number): boolean {
    return data[offset] === 0x74; // 't'
}

/**
 * Parse 1-byte signed integer (BYTEINT)
 */
export function byteRecv(data: Buffer, offset: number, length: number): number {
    const str = data.toString('ascii', offset, offset + length);
    return parseInt(str, 10);
}

/**
 * Parse 2-byte integer from text
 */
export function int2Recv(data: Buffer, offset: number, length: number): number {
    const str = data.toString('ascii', offset, offset + length);
    return parseInt(str, 10);
}

/**
 * Parse 4-byte integer from text
 */
export function int4Recv(data: Buffer, offset: number, length: number): number {
    const str = data.toString('ascii', offset, offset + length);
    return parseInt(str, 10);
}

/**
 * Parse 8-byte integer from text
 */
export function int8Recv(data: Buffer, offset: number, length: number): bigint | number {
    const str = data.toString('ascii', offset, offset + length);
    const num = parseInt(str, 10);
    // Return as BigInt only if outside safe integer range
    if (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER) {
        return BigInt(str);
    }
    return num;
}

/**
 * Parse 4-byte float from text
 */
export function float4Recv(data: Buffer, offset: number, length: number): number {
    const str = data.toString('ascii', offset, offset + length);
    return parseFloat(str);
}

/**
 * Parse 8-byte float from text
 */
export function float8Recv(data: Buffer, offset: number, length: number): number {
    const str = data.toString('ascii', offset, offset + length);
    return parseFloat(str);
}

/**
 * Parse numeric/decimal from text
 */
export function numericIn(data: Buffer, offset: number, length: number): number | string {
    const str = data.toString('ascii', offset, offset + length);
    const num = parseFloat(str);
    // Return as string if precision would be lost
    if (str.includes('.') && str.length > 15) {
        return str;
    }
    return num;
}

/**
 * Parse interval from text
 */
export function intervalRecv(data: Buffer, offset: number, length: number): string {
    return data.toString('ascii', offset, offset + length);
}

/**
 * Parse date from text (YYYY-MM-DD)
 */
export function dateIn(data: Buffer, offset: number, length: number): Date {
    const str = data.toString('ascii', offset, offset + length);
    try {
        const year = parseInt(str.substring(0, 4), 10);
        const month = parseInt(str.substring(5, 7), 10) - 1;
        const day = parseInt(str.substring(8, 10), 10);
        return new Date(Date.UTC(year, month, day));
    } catch {
        return new Date(0);
    }
}

/**
 * Parse time from text (HH:MM:SS.ffffff)
 */
export function timeIn(data: Buffer, offset: number, length: number): TimeValue {
    const str = data.toString('ascii', offset, offset + length);
    const hour = parseInt(str.substring(0, 2), 10);
    const minute = parseInt(str.substring(3, 5), 10);
    const secStr = str.substring(6);
    const secParts = secStr.split('.');
    const seconds = parseInt(secParts[0], 10);
    const microseconds = secParts.length > 1 ? parseInt(secParts[1].padEnd(6, '0').substring(0, 6), 10) : 0;

    return {
        hours: hour,
        minutes: minute,
        seconds,
        microseconds,
        toString(): string {
            const hh = String(hour).padStart(2, '0');
            const mm = String(minute).padStart(2, '0');
            const ss = String(seconds).padStart(2, '0');
            if (microseconds > 0) {
                const us = String(microseconds).padStart(6, '0');
                return `${hh}:${mm}:${ss}.${us}`;
            }
            return `${hh}:${mm}:${ss}`;
        },
    };
}

/**
 * Parse timestamp from text
 */
export function timestampIn(data: Buffer, offset: number, length: number): Date {
    const str = data.toString('ascii', offset, offset + length);
    return new Date(str);
}

/**
 * Parse timestamp from 8-byte float (seconds since 2000-01-01)
 */
export function timestampRecvFloat(data: Buffer, offset: number): Date {
    const EPOCH_SECONDS = 946684800.0; // 2000-01-01 UTC in Unix seconds
    const seconds = data.readDoubleLE(offset);
    return new Date((EPOCH_SECONDS + seconds) * 1000);
}

/**
 * Parse UUID from 16 bytes
 */
export function uuidRecv(data: Buffer, offset: number, length: number): string {
    if (length !== 16) {
        throw new Error('UUID must be exactly 16 bytes');
    }
    const hex = data.toString('hex', offset, offset + 16);
    return `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
}
