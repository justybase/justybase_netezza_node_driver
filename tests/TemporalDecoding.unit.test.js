/**
 * Binary TIMESTAMP/TIME decoding must match the previous BigInt-based
 * implementation (kept below as the reference) over the whole int64 range.
 */
const { toDateTimeFrom8Bytes, timeRecvFloat, POSTGRES_EPOCH_MS } = require('../dist/cjs/types/TypeConversions');

function referenceTimestamp(data, offset) {
    return new Date(POSTGRES_EPOCH_MS + Number(data.readBigInt64LE(offset) / 1000n));
}

function referenceTime(data, offset) {
    const micros = data.readBigInt64LE(offset);
    const totalSeconds = Number(micros / 1000000n);
    return {
        hours: Math.floor(totalSeconds / 3600),
        minutes: Math.floor((totalSeconds % 3600) / 60),
        seconds: totalSeconds % 60,
        microseconds: Number(micros % 1000000n),
    };
}

let seed = 0x2545f491;
function nextU32() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
}

const DAY_MICROS = 86_400_000_000n;
const EDGES = [
    0n,
    1n,
    -1n,
    999n,
    -999n,
    1000n,
    -1000n,
    -1001n,
    DAY_MICROS - 1n,
    -5n,
    -1_000_000n,
    (1n << 53n) - 1n,
    -(1n << 53n),
    (1n << 53n) + 1n,
    (1n << 63n) - 1n,
    -(1n << 63n),
    -63082281600000000n, // 0001-01-01
    252455615999999999n, // 9999-12-31 23:59:59.999999
    -1n * 1000n - 1n,
];

function randomMicros() {
    switch (nextU32() % 3) {
        case 0:
            return BigInt.asIntN(64, (BigInt(nextU32()) << 32n) | BigInt(nextU32()));
        case 1:
            return BigInt(nextU32()) * 1000n * (nextU32() % 2 ? 1n : -1n) + BigInt(nextU32() % 1000);
        default:
            return BigInt(nextU32() % 86_400_000) * 1000n + BigInt(nextU32() % 1000) - (nextU32() % 2 ? DAY_MICROS : 0n);
    }
}

function encode(micros, offset = 0) {
    const data = Buffer.alloc(offset + 8);
    data.writeBigInt64LE(micros, offset);
    return data;
}

function plainTime(value) {
    return { hours: value.hours, minutes: value.minutes, seconds: value.seconds, microseconds: value.microseconds };
}

describe('binary temporal decoding', () => {
    const values = [...EDGES, ...Array.from({ length: 20000 }, randomMicros)];

    test('TIMESTAMP matches the BigInt reference, including truncation toward zero', () => {
        for (const micros of values) {
            const data = encode(micros, 2);
            const actual = toDateTimeFrom8Bytes(data, 2).getTime();
            const expected = referenceTimestamp(data, 2).getTime();
            if (!Object.is(actual, expected)) throw new Error(`micros=${micros}: got ${actual}, expected ${expected}`);
        }
    });

    test('TIME matches the BigInt reference, field by field', () => {
        for (const micros of values) {
            const data = encode(micros, 1);
            const actual = plainTime(timeRecvFloat(data, 1));
            const expected = referenceTime(data, 1);
            for (const key of Object.keys(expected)) {
                if (!Object.is(actual[key], expected[key])) {
                    throw new Error(`micros=${micros} ${key}: got ${actual[key]}, expected ${expected[key]}`);
                }
            }
        }
    });

    test('TIME keeps its string form and plain-object shape', () => {
        const time = timeRecvFloat(encode(45_296_000_123n));
        expect(String(time)).toBe('12:34:56.000123');
        expect(JSON.parse(JSON.stringify(time))).toEqual({ hours: 12, minutes: 34, seconds: 56, microseconds: 123 });
        expect(String(timeRecvFloat(encode(0n)))).toBe('00:00:00');
    });
});
