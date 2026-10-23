/**
 * Loopback replay server for `.nzreplay.gz` fixtures (see NzReplayFixture.js).
 *
 * The recorded handshake segment is written as soon as a client connects; the
 * client's handshake answers (MD5 password included) are parsed only for
 * framing and otherwise ignored. The n-th query packet of a connection is
 * answered with `responses[n]` (the last response repeats), regardless of the
 * SQL text.
 *
 * Client framing: handshake packets are `i32 length (incl. itself) + body`,
 * query packets are `'P' + i32 command number + SQL + NUL`. A handshake length
 * can never start with 0x50, so the first byte tells the two apart.
 */

const net = require('net');

const QUERY_TAG = 0x50; // 'P'

class NzReplayServer {
    /**
     * @param {{handshake: Buffer, responses: Buffer[]}} fixture
     * @param {{chunkSize?: number}} [options] chunkSize splits every write
     *   into chunks of that many bytes to exercise fragmented reads.
     */
    constructor(fixture, options = {}) {
        this.fixture = fixture;
        this.chunkSize = options.chunkSize || 0;
        this.queries = [];
        this.connections = 0;
        this._sockets = new Set();
        this._server = net.createServer((socket) => this._onConnection(socket));
    }

    async start() {
        await new Promise((resolve, reject) => {
            this._server.once('error', reject);
            this._server.listen(0, '127.0.0.1', () => {
                this._server.off('error', reject);
                resolve();
            });
        });
        this.port = this._server.address().port;
        return this;
    }

    async stop() {
        for (const socket of this._sockets) socket.destroy();
        await new Promise((resolve) => this._server.close(() => resolve()));
    }

    connectionConfig(overrides = {}) {
        return {
            host: '127.0.0.1',
            port: this.port,
            database: 'JUST_DATA',
            user: 'replay',
            password: 'replay',
            securityLevel: 'OnlyUnsecuredSession',
            ...overrides,
        };
    }

    _onConnection(socket) {
        this.connections++;
        this._sockets.add(socket);
        socket.setNoDelay(true);
        socket.on('close', () => this._sockets.delete(socket));
        socket.on('error', () => {});

        let pending = Buffer.alloc(0);
        let nextResponse = 0;
        const { responses } = this.fixture;
        socket.on('data', (chunk) => {
            pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
            let offset = 0;
            for (;;) {
                if (pending.length - offset < 4) break;
                if (pending[offset] === QUERY_TAG) {
                    const end = pending.indexOf(0, offset + 5);
                    if (end < 0) break;
                    this.queries.push(pending.toString('utf8', offset + 5, end));
                    offset = end + 1;
                    this._send(socket, responses[Math.min(nextResponse++, responses.length - 1)]);
                } else {
                    const len = pending.readInt32BE(offset);
                    if (len < 4) {
                        socket.destroy(new Error(`Replay server: invalid client packet length ${len}`));
                        return;
                    }
                    if (pending.length - offset < len) break;
                    offset += len;
                }
            }
            pending = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset);
        });

        this._send(socket, this.fixture.handshake);
    }

    _send(socket, bytes) {
        if (!this.chunkSize || this.chunkSize >= bytes.length) {
            socket.write(bytes);
            return;
        }
        for (let i = 0; i < bytes.length; i += this.chunkSize) {
            socket.write(bytes.subarray(i, i + this.chunkSize));
        }
    }
}

module.exports = { NzReplayServer };
