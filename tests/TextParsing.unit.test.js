/**
 * Text-protocol value parsers have regex/split-free fast paths for the plain
 * formats Netezza sends. They must agree with the previous general
 * implementations (kept below as the reference) on every input, including
 * inputs the fast paths reject.
 */
const { createTextValueParser, createTextBufferParser } = require('../dist/cjs/types/TypeConversions');

function referenceTimestamp(value) {
    const trimmed = value.trim();
    let normalized = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        normalized = `${trimmed}T00:00:00.000Z`;
    } else {
        const match = trimmed.match(
            /^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)?(?:([+-])([0-9]{2})(?::?([0-9]{2}))?)?$/
        );
        if (match) {
            const [, datePart, timePart, fraction = '', sign, zoneHours, zoneMinutes] = match;
            const milliseconds = fraction ? `.${fraction.slice(1).padEnd(3, '0').slice(0, 3)}` : '';
            const timezone = sign ? `${sign}${zoneHours}:${zoneMinutes || '00'}` : 'Z';
            normalized = `${datePart}T${timePart}${milliseconds}${timezone}`;
        }
    }
    if (normalized) return new Date(normalized);
    const hasTimezone = /(?:[zZ]|[+-][0-9]{2}(?::?[0-9]{2})?)$/.test(trimmed);
    return new Date(`${trimmed.replace(' ', 'T')}${hasTimezone ? '' : 'Z'}`);
}

function referenceDate(value) {
    return new Date(`${value.trim()}T00:00:00.000Z`);
}

function referenceTime(value) {
    const timeString = value.trim();
    if (!timeString) return null;
    const parts = timeString.split(':');
    const secParts = (parts[2] || '0').split('.');
    return {
        hours: parseInt(parts[0], 10) || 0,
        minutes: parseInt(parts[1], 10) || 0,
        seconds: parseInt(secParts[0], 10) || 0,
        microseconds: secParts.length > 1 ? parseInt(secParts[1].substring(0, 6).padEnd(6, '0'), 10) : 0,
        text: timeString,
    };
}

function referenceBigInt(data, offset, len) {
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

let seed = 0x6d2b79f5;
function rand(n) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % n;
}

function pad(value, width) {
    return String(value).padStart(width, '0');
}

/** Mostly plausible values, with deliberate out-of-range fields and odd punctuation. */
function randomDate() {
    const year = [rand(10000), 1999, 2024, 99, 100, 1, 0][rand(7)];
    const month = rand(5) === 0 ? rand(100) : 1 + rand(12);
    const day = rand(5) === 0 ? rand(100) : 1 + rand(31);
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function randomTimestamp() {
    const hour = rand(6) === 0 ? rand(100) : rand(24);
    const minute = rand(8) === 0 ? rand(100) : rand(60);
    const second = rand(8) === 0 ? rand(100) : rand(60);
    let text = `${randomDate()}${rand(4) === 0 ? 'T' : ' '}${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
    if (rand(2) === 0) text += `.${String(rand(10 ** 9)).slice(0, 1 + rand(9))}`;
    switch (rand(8)) {
        case 0:
            text += `${rand(2) ? '+' : '-'}${pad(rand(30), 2)}`;
            break;
        case 1:
            text += `${rand(2) ? '+' : '-'}${pad(rand(30), 2)}:${pad(rand(70), 2)}`;
            break;
        case 2:
            text += `${rand(2) ? '+' : '-'}${pad(rand(30), 2)}${pad(rand(70), 2)}`;
            break;
        case 3:
            text += ['Z', ' ', '.', 'x', '+1', '+123'][rand(6)];
            break;
        default:
            break;
    }
    return rand(30) === 0 ? ` ${text}` : text;
}

function randomTime() {
    let text = `${pad(rand(30), 2)}:${pad(rand(70), 2)}:${pad(rand(70), 2)}`;
    if (rand(2) === 0) text += `.${String(rand(10 ** 9)).slice(0, rand(9))}`;
    if (rand(15) === 0) text += ['x', '+01', ' '][rand(3)];
    if (rand(20) === 0) text = text.slice(0, rand(text.length));
    return text;
}

function sameDate(actual, expected, input) {
    if (!Object.is(actual.getTime(), expected.getTime())) {
        throw new Error(`${JSON.stringify(input)}: got ${actual.getTime()}, expected ${expected.getTime()}`);
    }
}

describe('text-protocol value parsing', () => {
    const fixedTimestamps = [
        '2024-02-29 12:34:56.123456',
        '2024-02-29 12:34:56',
        '2024-02-29T12:34:56.1',
        '2024-02-30 00:00:00',
        '1999-12-31 23:59:59.999999',
        '0001-01-01 00:00:00',
        '0099-06-15 10:00:00',
        '9999-12-31 23:59:59.999',
        '2024-02-29 24:00:00',
        '2024-02-29 12:34:56+02',
        '2024-02-29 12:34:56-05:30',
        '2024-02-29 12:34:56+0530',
        '2024-02-29 12:34:56Z',
        '2024-02-29 12:34:56.',
        '2024-02-29',
        ' 2024-02-29 12:34:56 ',
        'not a timestamp',
    ];

    test('TIMESTAMP matches the reference parser', () => {
        const parse = createTextValueParser(1114);
        for (const input of [...fixedTimestamps, ...Array.from({ length: 30000 }, randomTimestamp)]) {
            sameDate(parse(input), referenceTimestamp(input), input);
        }
    });

    test('DATE matches the reference parser', () => {
        const parse = createTextValueParser(1082);
        const fixed = ['2024-02-29', '2024-02-30', '0001-01-01', '0099-12-31', '2024-13-01', '2024-00-10', ' 2024-02-29'];
        for (const input of [...fixed, ...Array.from({ length: 30000 }, randomDate)]) {
            sameDate(parse(input), referenceDate(input), input);
        }
    });

    test('TIME matches the reference parser, including its string form', () => {
        const parse = createTextValueParser(1083);
        const fixed = ['12:34:56', '00:00:00', '12:34:56.5', '12:34:56.123456', '12:34:56.1234567', '24:00:00', '1:2:3', ''];
        for (const input of [...fixed, ...Array.from({ length: 30000 }, randomTime)]) {
            const actual = parse(input);
            const expected = referenceTime(input);
            if (expected === null) {
                expect(actual).toBeNull();
                continue;
            }
            const got = { ...actual, text: String(actual) };
            delete got.toString;
            for (const key of Object.keys(expected)) {
                if (!Object.is(got[key], expected[key])) {
                    throw new Error(`${JSON.stringify(input)} ${key}: got ${got[key]}, expected ${expected[key]}`);
                }
            }
            expect(Object.keys(actual)).toEqual(['hours', 'minutes', 'seconds', 'microseconds', 'toString']);
        }
    });

    test('INT8 text matches the per-digit BigInt reference', () => {
        const parse = createTextBufferParser(20);
        const fixed = ['0', '-0', '-', '', '1', '-9223372036854775808', '9223372036854775807', '999999999999999', '1000000000000000', '-999999999999999', '12a4', '+5'];
        const random = Array.from({ length: 20000 }, () => {
            const digits = String(rand(10 ** 9)) + String(rand(10 ** 9)) + String(rand(10 ** 3));
            return `${rand(2) ? '-' : ''}${digits.slice(0, 1 + rand(digits.length))}`;
        });
        for (const input of [...fixed, ...random]) {
            const data = Buffer.from(`##${input}##`, 'latin1');
            const actual = parse(data, 2, input.length);
            const expected = referenceBigInt(data, 2, input.length);
            if (actual !== expected) throw new Error(`${JSON.stringify(input)}: got ${actual}, expected ${expected}`);
        }
    });
});
