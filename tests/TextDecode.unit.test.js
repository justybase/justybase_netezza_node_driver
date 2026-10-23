const { decodeUtf8, decodeLatin1 } = require('../dist/cjs/utils/textDecode');

describe('short-value text decoding', () => {
    const samples = ['', 'a', '0', '87', '875', 'abcd', 'abcde', 'ó', 'aó', 'Sábado', '€', 'x€', '\u0000', 'Zażółć gęślą jaźń'];

    test.each(samples)('decodeUtf8 matches Buffer#toString for %j', (text) => {
        const buf = Buffer.concat([Buffer.from('<<'), Buffer.from(text, 'utf8'), Buffer.from('>>')]);
        const end = buf.length - 2;
        expect(decodeUtf8(buf, 2, end)).toBe(buf.toString('utf8', 2, end));
    });

    test('decodeLatin1 matches Buffer#toString for every byte value and short length', () => {
        const buf = Buffer.from(Array.from({ length: 260 }, (_, i) => i & 0xff));
        for (let start = 0; start < 256; start++) {
            for (let len = 0; len <= 5; len++) {
                expect(decodeLatin1(buf, start, start + len)).toBe(buf.toString('latin1', start, start + len));
            }
        }
    });

    test('both fall back to Buffer#toString semantics for empty, negative and out-of-range spans', () => {
        const buf = Buffer.from('abc');
        for (const [start, end] of [
            [1, 1],
            [2, 1],
            [1, 9],
            [0, 3],
        ]) {
            expect(decodeUtf8(buf, start, end)).toBe(buf.toString('utf8', start, end));
            expect(decodeLatin1(buf, start, end)).toBe(buf.toString('latin1', start, end));
        }
    });
});
