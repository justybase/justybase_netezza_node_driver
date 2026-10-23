/**
 * getCsNumeric must keep the exact number-vs-string contract of the original
 * text-based implementation (kept below as the reference) while decoding
 * without building and parsing decimal text.
 */
const { getCsNumeric } = require('../dist/cjs/types/TypeConversions');

function referenceGetCsNumeric(data, prec, scale, digitCount, offset = 0) {
    const partCount = digitCount > 0 ? digitCount : prec <= 9 ? 1 : prec <= 18 ? 2 : 4;
    let raw = 0n;
    for (let i = 0; i < partCount; i++) raw = (raw << 32n) | BigInt(data.readUInt32LE(offset + i * 4));
    const totalBits = BigInt(partCount) * 32n;
    if ((raw & (1n << (totalBits - 1n))) !== 0n) raw -= 1n << totalBits;
    const isMinus = raw < 0n;
    let result = (isMinus ? -raw : raw).toString();
    if (scale !== 0) {
        const padded = result.padStart(scale + 1, '0');
        const decimalStart = padded.length - scale;
        result = `${padded.slice(0, decimalStart)}.${padded.slice(decimalStart)}`;
    }
    if (isMinus) result = `-${result}`;
    const num = parseFloat(result);
    if (prec <= 15 && result === String(num)) return num;
    return result;
}

function encode(value, partCount, offset = 0) {
    const data = Buffer.alloc(offset + partCount * 4);
    const bits = BigInt(partCount * 32);
    let raw = value < 0n ? (1n << bits) + value : value;
    for (let i = partCount - 1; i >= 0; i--) {
        data.writeUInt32LE(Number(raw & 0xffffffffn), offset + i * 4);
        raw >>= 32n;
    }
    return data;
}

function partCountFor(prec) {
    return prec <= 9 ? 1 : prec <= 18 ? 2 : 4;
}

// Deterministic xorshift so failures are reproducible.
let seed = 0x9e3779b9;
function nextU32() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
}

function randomUnscaled(prec) {
    const digits = 1 + (nextU32() % prec);
    let value = 0n;
    for (let i = 0; i < digits; i++) value = value * 10n + BigInt(nextU32() % 10);
    // Bias towards trailing zeros and tiny values, where the contract branches.
    if (nextU32() % 4 === 0) value = (value / 10n) * 10n;
    return nextU32() % 2 === 0 ? -value : value;
}

function expectSame(data, prec, scale, digitCount, offset) {
    const actual = getCsNumeric(data, prec, scale, digitCount, offset);
    const expected = referenceGetCsNumeric(data, prec, scale, digitCount, offset);
    if (typeof actual !== typeof expected || !Object.is(actual, expected)) {
        throw new Error(
            `prec=${prec} scale=${scale} digits=${digitCount} bytes=${data.toString('hex')}: ` +
                `got ${typeof actual} ${String(actual)}, expected ${typeof expected} ${String(expected)}`
        );
    }
}

describe('getCsNumeric', () => {
    test('matches the reference on the documented edge cases', () => {
        const cases = [
            [1, 0, 0n],
            [1, 0, 9n],
            [1, 0, -9n],
            [10, 4, 0n],
            [10, 4, 31400n],
            [10, 4, -1n],
            [10, 4, 9999999999n],
            [11, 6, 1250n],
            [11, 6, 320000n],
            [15, 0, 999999999999999n],
            [15, 15, 1n],
            [15, 7, 9n],
            [15, 6, 1n],
            [15, 7, 10n],
            [15, 14, -123456789012345n],
            [18, 0, 999999999999999999n],
            [18, 0, -999999999999999999n],
            [18, 2, 9007199254740993n],
            [38, 0, 99999999999999999999999999999999999999n],
            [38, 10, -123456789012345678901234567890123456n],
            [38, 38, 99999999999999999999999999999999999999n],
            [38, 38, -50000000000000000000000000000000000000n],
            [38, 0, 9007199254740991n],
            [38, 0, -9007199254740991n],
            [38, 0, 9007199254740992n],
            [38, 0, -(1n << 63n)],
        ];
        for (const [prec, scale, value] of cases) {
            const partCount = partCountFor(prec);
            expectSame(encode(value, partCount), prec, scale, 0, 0);
            expectSame(encode(value, partCount, 3), prec, scale, partCount, 3);
        }
    });

    test('matches the reference on random values for every precision and scale', () => {
        for (let prec = 1; prec <= 38; prec++) {
            const partCount = partCountFor(prec);
            for (let scale = 0; scale <= prec; scale++) {
                for (let i = 0; i < 40; i++) {
                    expectSame(encode(randomUnscaled(prec), partCount), prec, scale, 0, 0);
                }
            }
        }
    });

    test('matches the reference on arbitrary word patterns, including out-of-range values', () => {
        for (let i = 0; i < 20000; i++) {
            const partCount = [1, 2, 4][nextU32() % 3];
            const data = Buffer.alloc(partCount * 4);
            for (let w = 0; w < partCount; w++) {
                const pattern = nextU32() % 4;
                const word = pattern === 0 ? 0 : pattern === 1 ? 0xffffffff : nextU32();
                data.writeUInt32LE(word, w * 4);
            }
            const prec = 1 + (nextU32() % 38);
            expectSame(data, prec, nextU32() % (prec + 1), partCount, 0);
        }
    });
});
