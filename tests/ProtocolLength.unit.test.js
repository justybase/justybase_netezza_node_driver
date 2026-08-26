const {
    MAX_PROTOCOL_PAYLOAD,
    validateProtocolLength,
    validateProtocolLengthAfterOverhead,
} = require('../dist/cjs/protocol/ProtocolLength');

describe('protocol length validation', () => {
    test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid length %s', (length) => {
        expect(() => validateProtocolLength(length, 'payload')).toThrow(/Invalid backend protocol length/);
    });

    test('rejects payloads above the defensive maximum', () => {
        expect(() => validateProtocolLength(MAX_PROTOCOL_PAYLOAD + 1, 'payload')).toThrow(/maximum supported/);
    });

    test('can reject zero for required protocol fields', () => {
        expect(() => validateProtocolLength(0, 'payload', { allowZero: false })).toThrow(/zero is not valid/);
        expect(validateProtocolLength(0, 'emptyPayload')).toBe(0);
    });

    test('validates a frame before subtracting its fixed overhead', () => {
        expect(validateProtocolLengthAfterOverhead(5, 4, 'frame', 'payload')).toBe(1);
        expect(validateProtocolLengthAfterOverhead(4, 4, 'frame', 'payload')).toBe(0);
        expect(() => validateProtocolLengthAfterOverhead(3, 4, 'frame', 'payload')).toThrow(/smaller than/);
        expect(() => validateProtocolLengthAfterOverhead(0, 4, 'frame', 'payload')).toThrow(/frame/);
    });
});
