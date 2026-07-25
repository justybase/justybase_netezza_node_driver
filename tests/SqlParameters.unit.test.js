/**
 * Offline unit tests for client-side SQL parameter escaping / substitution.
 */

const {
    escapeLiteral,
    substituteParameters,
} = require('../dist/cjs/protocol/sqlParameters');

describe('escapeLiteral', () => {
    test('null and undefined become NULL', () => {
        expect(escapeLiteral(null)).toBe('NULL');
        expect(escapeLiteral(undefined)).toBe('NULL');
    });

    test('booleans use t/f literals', () => {
        expect(escapeLiteral(true)).toBe("'t'");
        expect(escapeLiteral(false)).toBe("'f'");
    });

    test('numbers and bigints are unquoted', () => {
        expect(escapeLiteral(42)).toBe('42');
        expect(escapeLiteral(3.14)).toBe('3.14');
        expect(escapeLiteral(10n)).toBe('10');
    });

    test('rejects non-finite numbers', () => {
        expect(() => escapeLiteral(NaN)).toThrow(TypeError);
        expect(() => escapeLiteral(Infinity)).toThrow(TypeError);
    });

    test('strings escape single quotes', () => {
        expect(escapeLiteral("O'Reilly")).toBe("'O''Reilly'");
        expect(escapeLiteral('plain')).toBe("'plain'");
    });

    test('dates use historical UTC formatting', () => {
        const d = new Date('2024-06-15T12:30:45.123Z');
        expect(escapeLiteral(d)).toBe("'2024-06-15 12:30:45'");
    });

    test('rejects invalid dates', () => {
        expect(() => escapeLiteral(new Date('invalid'))).toThrow(TypeError);
    });

    test('buffers use hex escape', () => {
        expect(escapeLiteral(Buffer.from([0xab, 0xcd]))).toBe("E'\\\\xabcd'");
    });

    test('rejects unsupported object types', () => {
        expect(() => escapeLiteral({ a: 1 })).toThrow(TypeError);
        expect(() => escapeLiteral([1, 2])).toThrow(TypeError);
    });
});

describe('substituteParameters', () => {
    test('returns sql unchanged when params empty', () => {
        expect(substituteParameters('SELECT $1', [])).toBe('SELECT $1');
        expect(substituteParameters('SELECT 1', null)).toBe('SELECT 1');
    });

    test('replaces $1, $2 placeholders', () => {
        expect(substituteParameters('SELECT $1, $2', ['a', 2])).toBe("SELECT 'a', 2");
    });

    test('leaves unmatched placeholders unchanged', () => {
        expect(substituteParameters('SELECT $1, $3', ['x'])).toBe("SELECT 'x', $3");
    });

    test('supports repeated placeholder references', () => {
        expect(substituteParameters('SELECT $1 || $1', ['ab'])).toBe("SELECT 'ab' || 'ab'");
    });
});
