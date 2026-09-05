import { EventEmitter } from 'node:events';
import type * as net from 'node:net';
import type * as tls from 'node:tls';
import { validateProtocolLength } from '../protocol/ProtocolLength';

export type Stream = net.Socket | tls.TLSSocket;

/**
 * Growable byte buffer over a TCP/TLS stream.
 * Shared by handshake and connection layers so read/error semantics stay consistent.
 */
export class SocketTransport extends EventEmitter {
    private _stream: Stream | null = null;
    private _intBuf: Buffer = Buffer.allocUnsafe(65536);
    private _intBufStart = 0;
    private _intBufEnd = 0;
    /** Optional diagnostics counters (mutated in place when provided) */
    diag: Record<string, number> | null = null;

    attach(stream: Stream): void {
        this._stream = stream;
        this._intBufStart = 0;
        this._intBufEnd = 0;
    }

    get stream(): Stream | null {
        return this._stream;
    }

    get connected(): boolean {
        return !!this._stream && !this._stream.destroyed;
    }

    write(data: Buffer | string, cb?: (err?: Error | null) => void): void {
        if (!this._stream || this._stream.destroyed) {
            throw new Error('Socket closed or destroyed during write');
        }
        this._stream.write(data, cb);
    }

    private _ensureBufferCapacity(needed: number): void {
        const remaining = this._intBufEnd - this._intBufStart;

        if (this._intBuf.length - this._intBufEnd >= needed) return;

        if (this._intBuf.length - remaining >= needed) {
            if (remaining > 0) {
                this._intBuf.copy(this._intBuf, 0, this._intBufStart, this._intBufEnd);
            }
            if (this.diag) {
                this.diag.ensureBufferCompactions = (this.diag.ensureBufferCompactions || 0) + 1;
            }
            this._intBufStart = 0;
            this._intBufEnd = remaining;
            return;
        }

        const newSize = Math.max(this._intBuf.length * 2, remaining + needed, 65536);
        const newBuf = Buffer.allocUnsafe(newSize);
        if (remaining > 0) {
            this._intBuf.copy(newBuf, 0, this._intBufStart, this._intBufEnd);
        }
        if (this.diag) {
            this.diag.ensureBufferRegrows = (this.diag.ensureBufferRegrows || 0) + 1;
        }
        this._intBuf = newBuf;
        this._intBufStart = 0;
        this._intBufEnd = remaining;
    }

    /**
     * Bytes currently buffered but not yet consumed.
     */
    bufferedLength(): number {
        return this._intBufEnd - this._intBufStart;
    }

    /**
     * Peek at buffered bytes without consuming (for batch DBOS reads).
     */
    peekBuffer(): { buf: Buffer; start: number; end: number } {
        return { buf: this._intBuf, start: this._intBufStart, end: this._intBufEnd };
    }

    consume(n: number): void {
        this._intBufStart += n;
    }

    /**
     * Push any unconsumed transport buffer bytes back onto the Node stream
     * so a subsequent consumer (e.g. NzConnection after handshake) can read them.
     */
    flushUnreadToStream(): void {
        const remaining = this._intBufEnd - this._intBufStart;
        if (remaining <= 0 || !this._stream || this._stream.destroyed) {
            this._intBufStart = 0;
            this._intBufEnd = 0;
            return;
        }
        const leftover = Buffer.allocUnsafe(remaining);
        this._intBuf.copy(leftover, 0, this._intBufStart, this._intBufEnd);
        this._intBufStart = 0;
        this._intBufEnd = 0;
        this._stream.unshift(leftover);
    }

    async readBytes(n: number): Promise<Buffer> {
        validateProtocolLength(n, 'transport read');
        if (this.diag) {
            this.diag.readBytesCalls = (this.diag.readBytesCalls || 0) + 1;
            this.diag.readBytesBytes = (this.diag.readBytesBytes || 0) + n;
        }

        if (!this._stream || this._stream.destroyed) {
            throw new Error('Socket closed or destroyed during read');
        }

        while (this._intBufEnd - this._intBufStart < n) {
            await this._fillFromStream();
        }

        const out = Buffer.allocUnsafe(n);
        this._intBuf.copy(out, 0, this._intBufStart, this._intBufStart + n);
        this._intBufStart += n;
        return out;
    }

    async readByte(): Promise<number> {
        const b = await this.readBytes(1);
        return b[0];
    }

    async readInt32(): Promise<number> {
        const b = await this.readBytes(4);
        return b.readInt32BE(0);
    }

    private _fillFromStream(): Promise<void> {
        return new Promise((resolve, reject) => {
            const stream = this._stream;
            if (!stream || stream.destroyed) {
                return reject(new Error('Socket closed/ended during read'));
            }

            const onReadable = () => {
                cleanup();
                try {
                    this._pumpReadable();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            };
            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };
            const onEnd = () => {
                cleanup();
                reject(new Error('Socket closed/ended during read'));
            };
            const cleanup = () => {
                stream.off('readable', onReadable);
                stream.off('error', onError);
                stream.off('end', onEnd);
                stream.off('close', onEnd);
            };

            // Try sync first
            const before = this._intBufEnd - this._intBufStart;
            this._pumpReadable();
            if (this._intBufEnd - this._intBufStart > before) {
                return resolve();
            }

            if (this.diag) {
                this.diag.readBytesSlowCalls = (this.diag.readBytesSlowCalls || 0) + 1;
            }

            stream.on('readable', onReadable);
            stream.on('error', onError);
            stream.on('end', onEnd);
            stream.on('close', onEnd);
        });
    }

    private _pumpReadable(): void {
        const stream = this._stream;
        if (!stream) return;
        // Read available chunks into the growable buffer
        for (;;) {
            const chunk = stream.read() as Buffer | null;
            if (!chunk || chunk.length === 0) break;
            this._ensureBufferCapacity(chunk.length);
            chunk.copy(this._intBuf, this._intBufEnd);
            this._intBufEnd += chunk.length;
            if (this.diag) {
                this.diag.readBytesSlowBytes = (this.diag.readBytesSlowBytes || 0) + chunk.length;
            }
        }
    }

    destroy(): void {
        if (this._stream && !this._stream.destroyed) {
            this._stream.destroy();
        }
        this._stream = null;
    }

    end(): void {
        if (this._stream && !this._stream.destroyed) {
            this._stream.end();
        }
    }
}
