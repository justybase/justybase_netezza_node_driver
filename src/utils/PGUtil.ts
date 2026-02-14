import { Writable } from 'stream';

/**
 * PostgreSQL/Netezza protocol utility functions
 */
class PGUtil {
    /**
     * Reads a 32-bit integer from the buffer at the given offset.
     * Big-endian (network byte order).
     */
    static readInt32(buffer: Buffer, offset: number = 0): number {
        return buffer.readInt32BE(offset);
    }

    /**
     * Reads a 16-bit integer from the buffer at the given offset.
     * Big-endian.
     */
    static readInt16(buffer: Buffer, offset: number = 0): number {
        return buffer.readInt16BE(offset);
    }

    /**
     * Writes a 32-bit integer to the stream or buffer.
     */
    static writeInt32(target: Writable | Buffer, value: number, offset: number = 0): void {
        if (Buffer.isBuffer(target)) {
            target.writeInt32BE(value, offset);
        } else {
            const buf = Buffer.allocUnsafe(4);
            buf.writeInt32BE(value, 0);
            target.write(buf);
        }
    }

    /**
     * Writes a 16-bit integer to the stream or buffer.
     */
    static writeInt16(target: Writable | Buffer, value: number, offset: number = 0): void {
        if (Buffer.isBuffer(target)) {
            target.writeInt16BE(value, offset);
        } else {
            const buf = Buffer.allocUnsafe(2);
            buf.writeInt16BE(value, 0);
            target.write(buf);
        }
    }
}

export { PGUtil };
