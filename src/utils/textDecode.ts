/**
 * Short-value string decoding for row hot paths.
 */

/**
 * `buf.toString('utf8', start, end)` with a JS fast path for 1-4 byte ASCII
 * values, where the native call costs more than the decoding itself.
 */
export function decodeUtf8(buf: Buffer, start: number, end: number): string {
    const n = end - start;
    if (n > 0 && n <= 4 && end <= buf.length) {
        const c0 = buf[start];
        if (n === 1) {
            if (c0 < 0x80) return String.fromCharCode(c0);
        } else {
            const c1 = buf[start + 1];
            if (n === 2) {
                if ((c0 | c1) < 0x80) return String.fromCharCode(c0, c1);
            } else {
                const c2 = buf[start + 2];
                if (n === 3) {
                    if ((c0 | c1 | c2) < 0x80) return String.fromCharCode(c0, c1, c2);
                } else {
                    const c3 = buf[start + 3];
                    if ((c0 | c1 | c2 | c3) < 0x80) return String.fromCharCode(c0, c1, c2, c3);
                }
            }
        }
    }
    return buf.toString('utf8', start, end);
}

/** `buf.toString('latin1', start, end)` with the same short-value fast path (every byte maps to one char). */
export function decodeLatin1(buf: Buffer, start: number, end: number): string {
    const n = end - start;
    if (n > 0 && n <= 4 && end <= buf.length) {
        if (n === 1) return String.fromCharCode(buf[start]);
        if (n === 2) return String.fromCharCode(buf[start], buf[start + 1]);
        if (n === 3) return String.fromCharCode(buf[start], buf[start + 1], buf[start + 2]);
        return String.fromCharCode(buf[start], buf[start + 1], buf[start + 2], buf[start + 3]);
    }
    return buf.toString('latin1', start, end);
}
