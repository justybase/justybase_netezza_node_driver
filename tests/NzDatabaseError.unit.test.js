/**
 * Offline unit tests for NzDatabaseError and backend error field parsing.
 */

const {
    NzDatabaseError,
    parseBackendErrorFields,
    createNzDatabaseError,
} = require('../dist/cjs/errors/NzDatabaseError');

/** Build a PG-style ErrorResponse body: typeByte + cstring ... + final NUL */
function encodeFields(fields) {
    const parts = [];
    for (const [type, value] of fields) {
        parts.push(Buffer.from([type.charCodeAt(0)]));
        parts.push(Buffer.from(value, 'utf8'));
        parts.push(Buffer.from([0]));
    }
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}

describe('parseBackendErrorFields', () => {
    test('parses severity, code, message, detail, hint', () => {
        const buf = encodeFields([
            ['S', 'ERROR'],
            ['C', '42P01'],
            ['M', 'relation "foo" does not exist'],
            ['D', 'extra detail'],
            ['H', 'check the name'],
        ]);
        const parsed = parseBackendErrorFields(buf);
        expect(parsed.severity).toBe('ERROR');
        expect(parsed.code).toBe('42P01');
        expect(parsed.message).toBe('relation "foo" does not exist');
        expect(parsed.detail).toBe('extra detail');
        expect(parsed.hint).toBe('check the name');
        expect(parsed.raw).toContain('relation "foo" does not exist');
    });

    test('falls back to raw text when no M field', () => {
        const parsed = parseBackendErrorFields(Buffer.from('plain error text\0', 'utf8'));
        expect(parsed.message).toMatch(/plain error text|Unknown Netezza error/);
    });

    test('accepts string payloads', () => {
        const buf = encodeFields([['M', 'hello']]);
        const parsed = parseBackendErrorFields(buf.toString('binary'));
        expect(parsed.message).toBe('hello');
    });
});

describe('NzDatabaseError', () => {
    test('exposes structured fields and Error message', () => {
        const err = new NzDatabaseError({
            severity: 'ERROR',
            code: '42601',
            message: 'syntax error',
            detail: 'near SELECT',
            hint: 'check SQL',
            raw: 'raw',
        });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(NzDatabaseError);
        expect(err.name).toBe('NzDatabaseError');
        expect(err.message).toBe('syntax error');
        expect(err.dbMessage).toBe('syntax error');
        expect(err.severity).toBe('ERROR');
        expect(err.code).toBe('42601');
        expect(err.detail).toBe('near SELECT');
        expect(err.hint).toBe('check SQL');
        expect(err.raw).toBe('raw');
    });

    test('createNzDatabaseError builds from buffer', () => {
        const buf = encodeFields([
            ['S', 'FATAL'],
            ['C', '28P01'],
            ['M', 'password authentication failed'],
        ]);
        const err = createNzDatabaseError(buf);
        expect(err).toBeInstanceOf(NzDatabaseError);
        expect(err.severity).toBe('FATAL');
        expect(err.code).toBe('28P01');
        expect(err.message).toBe('password authentication failed');
    });
});
