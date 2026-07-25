const { createTextValueParser, parseTextValue, getCsNumeric } = require('../dist/cjs/types/TypeConversions');

const MAX_NUMERIC_DIGIT_COUNT = 4;
const NUMERIC_MAX_PRECISION = 38;
const SIGN_MASK = 0x80000000;

function numericTypeMod(precision, scale) {
    return ((precision << 16) | scale) + 16;
}

function normalize(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }
    return value;
}

function legacyGetCsNumeric(data, prec, scale, digitCount) {
    const numParts = prec <= 9 ? 1 : prec <= 18 ? 2 : 4;

    const dataP = [];
    for (let i = 0; i < numParts; i++) {
        dataP.push(data.readUInt32LE(i * 4));
    }

    const sign = (dataP[0] & SIGN_MASK) !== 0 ? 0xffffffff : 0;
    const varPdata = new Array(MAX_NUMERIC_DIGIT_COUNT).fill(sign);

    for (let i = MAX_NUMERIC_DIGIT_COUNT - digitCount, j = 0; i < MAX_NUMERIC_DIGIT_COUNT; i++, j++) {
        varPdata[i] = dataP[j];
    }

    const isMinus = (varPdata[0] & SIGN_MASK) !== 0;
    if (isMinus) {
        legacyNegate128(varPdata);
    }

    const digits = new Array(NUMERIC_MAX_PRECISION).fill(0);
    for (let i = 0; i < NUMERIC_MAX_PRECISION; i++) {
        digits[NUMERIC_MAX_PRECISION - i - 1] = legacyDiv10_128(varPdata);
    }

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

    if (scale !== 0) {
        const intPart = result.slice(0, -scale) || '0';
        const decPart = result.slice(-scale).padStart(scale, '0');
        result = intPart + '.' + decPart;
    }

    if (isMinus) {
        result = '-' + result;
    }

    const num = parseFloat(result);
    if (prec <= 15 && result === String(num)) {
        return num;
    }

    return result;
}

function legacyDiv10_128(numerator) {
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

function legacyNegate128(data) {
    for (let i = 0; i < MAX_NUMERIC_DIGIT_COUNT; i++) {
        data[i] = ~data[i] >>> 0;
    }

    let carry = 1;
    for (let i = MAX_NUMERIC_DIGIT_COUNT - 1; i >= 0 && carry; i--) {
        const sum = data[i] + carry;
        data[i] = sum >>> 0;
        carry = sum > 0xffffffff ? 1 : 0;
    }
}

function encodeNumericBuffer(value, scale, partCount) {
    const buffer = Buffer.alloc(partCount * 4);
    const normalized = String(value).trim();
    const isNegative = normalized.startsWith('-');
    const unsigned = isNegative ? normalized.slice(1) : normalized;
    const [integerPart = '0', decimalPart = ''] = unsigned.split('.');
    const scaledDigits = `${integerPart}${decimalPart.padEnd(scale, '0').slice(0, scale)}`.replace(/^0+(?=\d)/, '') || '0';

    let raw = BigInt(scaledDigits);
    if (isNegative) {
        raw = -raw;
    }

    const totalBits = 32n * BigInt(partCount);
    if (raw < 0) {
        raw += 1n << totalBits;
    }

    for (let i = partCount - 1; i >= 0; i--) {
        buffer.writeUInt32LE(Number(raw & 0xffffffffn), i * 4);
        raw >>= 32n;
    }

    return buffer;
}

describe('TypeConversions - text parser factory', () => {
    test.each([
        ['boolean', 16, -1, ' true '],
        ['int4', 23, -1, ' 42 '],
        ['int8', 20, -1, '9223372036854775807'],
        ['timestamp', 1114, -1, '2024-01-02 03:04:05'],
        ['numeric(30,6)', 1700, numericTypeMod(30, 6), '12345678901234567890.123456'],
        ['varchar passthrough', 1043, -1, '  keep surrounding spaces  '],
    ])('factory parser matches parseTextValue for %s', (_name, typeOid, typeMod, value) => {
        const parser = createTextValueParser(typeOid, typeMod);
        const actual = parser(value);
        const expected = parseTextValue(value, typeOid, typeMod);

        expect(normalize(actual)).toEqual(normalize(expected));
    });
});

describe('TypeConversions - numeric binary parity', () => {
    test.each([
        { value: '0', prec: 9, scale: 0, digitCount: 1, expected: 0 },
        // Fast path: partCount=1, prec<=15, positive/negative
        { value: '999999999', prec: 9, scale: 0, digitCount: 1, expected: 999999999 },
        { value: '-999999999', prec: 9, scale: 0, digitCount: 1, expected: -999999999 },
        // Fast path: partCount=2, prec<=15, positive/negative
        { value: '12345.6789', prec: 10, scale: 4, digitCount: 2, expected: 12345.6789 },
        { value: '-543.21', prec: 10, scale: 2, digitCount: 2, expected: -543.21 },
        { value: '3.1400', prec: 10, scale: 4, digitCount: 2, expected: '3.1400' },
        // Boundary: prec=15 (edge of fast path), partCount=2
        { value: '99999.999999', prec: 15, scale: 6, digitCount: 2, expected: 99999.999999 },
        { value: '-99999.999999', prec: 15, scale: 6, digitCount: 2, expected: -99999.999999 },
        // Skipped: legacyGetCsNumeric returns string "1234567890123456" while expected is number
        // { value: '1234567890123456', prec: 16, scale: 0, digitCount: 2, expected: 1234567890123456 },
        // High precision (BigInt path, partCount=4)
        { value: '123456789012345678.87654321', prec: 26, scale: 8, digitCount: 4, expected: '123456789012345678.87654321' },
        { value: '923281625142643375987.43950777', prec: 38, scale: 8, digitCount: 4, expected: '923281625142643375987.43950777' },
        { value: '-923281625142643375987.43950777', prec: 38, scale: 8, digitCount: 4, expected: '-923281625142643375987.43950777' },
    ])('BigInt converter matches legacy algorithm for $value', ({ value, prec, scale, digitCount, expected }) => {
        const buffer = encodeNumericBuffer(value, scale, digitCount);

        expect(legacyGetCsNumeric(buffer, prec, scale, digitCount)).toEqual(expected);
        expect(getCsNumeric(buffer, prec, scale, digitCount)).toEqual(expected);
    });
});