const { EventEmitter } = require('events');
const { Handshake } = require('../dist/cjs/Handshake');
const { NzDatabaseError } = require('../dist/cjs/errors/NzDatabaseError');
const { BackendMessageCode } = require('../dist/cjs/protocol/constants');

class ReadSocket extends EventEmitter {
    constructor(bytes) {
        super();
        this.destroyed = false;
        this.chunks = [Buffer.from(bytes)];
        this.writes = [];
    }

    read() {
        return this.chunks.shift() || null;
    }

    unshift(chunk) {
        this.chunks.unshift(Buffer.from(chunk));
    }

    write(data) {
        this.writes.push(Buffer.from(data));
        return true;
    }
}

function int32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value, 0);
    return buffer;
}

function createHandshake(bytes) {
    const socket = new ReadSocket(bytes);
    const handshake = new Handshake(socket, socket, 'host');
    return { handshake, socket };
}

describe('Handshake protocol framing', () => {
    test.each([-1, 3, 10_000_001])('rejects invalid ErrorResponse frame length %s', async (length) => {
        const { handshake } = createHandshake(Buffer.concat([Buffer.from([BackendMessageCode.ErrorResponse]), int32(length)]));

        await expect(handshake.connConnectionComplete()).rejects.toThrow(/connectionCompleteError/);
    });

    test('preserves a valid structured ErrorResponse during connection completion', async () => {
        const body = Buffer.from('SERROR\0CXX000\0Mhandshake failed\0\0');
        const { handshake } = createHandshake(
            Buffer.concat([Buffer.from([BackendMessageCode.ErrorResponse]), int32(4 + body.length), body])
        );

        await expect(handshake.connConnectionComplete()).rejects.toBeInstanceOf(NzDatabaseError);
        await expect(
            createHandshake(
                Buffer.concat([Buffer.from([BackendMessageCode.ErrorResponse]), int32(4 + body.length), body])
            ).handshake.connConnectionComplete()
        ).rejects.toThrow('handshake failed');
    });

    test('preserves a legacy NUL-terminated text ErrorResponse during connection completion', async () => {
        const { handshake } = createHandshake(
            Buffer.concat([
                Buffer.from([BackendMessageCode.ErrorResponse]),
                Buffer.from('Password authentication failed\0')
            ])
        );

        await expect(handshake.connConnectionComplete()).rejects.toThrow(/password authentication failed/i);
    });

    test('rejects invalid NoticeResponse length during connection completion', async () => {
        const { handshake } = createHandshake(
            Buffer.concat([Buffer.from([BackendMessageCode.NoticeResponse]), Buffer.alloc(4), int32(-1)])
        );

        await expect(handshake.connConnectionComplete()).rejects.toThrow(/connectionCompleteNoticePayload/);
    });

    test('does not hide an invalid v2 handshake ErrorResponse length', async () => {
        const { handshake } = createHandshake(Buffer.concat([Buffer.from('N'), Buffer.from([BackendMessageCode.ErrorResponse]), int32(-1)]));

        await expect(handshake.connSendHandshakeVersion2(6, 'user')).rejects.toThrow(/handshakeErrorFrameLength/);
    });

    test('accepts the normal ReadyForQuery connection-complete marker', async () => {
        const { handshake } = createHandshake(Buffer.concat([Buffer.from([BackendMessageCode.ReadyForQuery]), Buffer.alloc(4)]));

        await expect(handshake.connConnectionComplete()).resolves.toBe(true);
    });
});
