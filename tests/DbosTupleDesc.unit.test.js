const { DbosTupleDesc } = require('../dist/cjs/DbosTupleDesc');

function makeDescriptor({ fieldCount = 1, fieldType = 3 } = {}) {
    const data = Buffer.alloc(36 + fieldCount * 36 + 8);
    let offset = 0;
    for (const value of [1, 1, 8, 4, fieldCount, 0, 4, 64, fieldCount]) {
        data.writeInt32BE(value, offset);
        offset += 4;
    }
    for (let i = 0; i < fieldCount; i++) {
        for (const value of [fieldType, 4 << 8 | 2, 4, 0, i, i, 1, 4, 0]) {
            data.writeInt32BE(value, offset);
            offset += 4;
        }
    }
    data.writeInt32BE(0, offset);
    data.writeInt32BE(0, offset + 4);
    return data;
}

describe('DbosTupleDesc', () => {
    test('parses fields and exposes numeric precision and scale', () => {
        const descriptor = new DbosTupleDesc();
        descriptor.parse(makeDescriptor());

        expect(descriptor.numFields).toBe(1);
        expect(descriptor.fieldType).toEqual([3]);
        expect(descriptor.fieldNullAllowed).toEqual([true]);
        expect(descriptor.getFieldPrecision(0)).toBe(4);
        expect(descriptor.getFieldScale(0)).toBe(2);
    });

    test('applies the ABS_TIME type compatibility correction', () => {
        const descriptor = new DbosTupleDesc();
        descriptor.parse(makeDescriptor({ fieldType: 3 }), {
            description: [{ typeOid: 702 }],
        });

        expect(descriptor.fieldType).toEqual([39]);
    });

    test('rejects truncated and impossible descriptors', () => {
        const descriptor = new DbosTupleDesc();
        expect(() => descriptor.parse(Buffer.alloc(35))).toThrow(/header is truncated/);
        expect(() => descriptor.parse(makeDescriptor().subarray(0, 70))).toThrow(/expected at least/);

        const invalid = makeDescriptor();
        invalid.writeInt32BE(-1, 32);
        expect(() => descriptor.parse(invalid)).toThrow(/field count/);
    });
});
