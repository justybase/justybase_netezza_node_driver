const { EventEmitter } = require('events');
const { SocketTransport } = require('../dist/cjs/transport/SocketTransport');

class FakeReadableSocket extends EventEmitter {
    constructor(chunks = []) {
        super();
        this.destroyed = false;
        this.chunks = chunks.map((chunk) => Buffer.from(chunk));
        this.unshifted = [];
    }

    read() {
        return this.chunks.shift() || null;
    }

    unshift(chunk) {
        this.unshifted.unshift(Buffer.from(chunk));
        this.chunks.unshift(Buffer.from(chunk));
    }

    write(_data, callback) {
        if (callback) callback();
        return true;
    }

    destroy() {
        this.destroyed = true;
        this.emit('close');
    }

    end() {
        this.emit('end');
    }
}

describe('SocketTransport', () => {
    test('reads coalesced data and keeps unread bytes for the next read', async () => {
        const socket = new FakeReadableSocket([Buffer.from('abcdef')]);
        const transport = new SocketTransport();
        transport.attach(socket);

        await expect(transport.readBytes(2)).resolves.toEqual(Buffer.from('ab'));
        await expect(transport.readBytes(4)).resolves.toEqual(Buffer.from('cdef'));
        expect(transport.bufferedLength()).toBe(0);
    });

    test('waits for later fragments and preserves their order', async () => {
        const socket = new FakeReadableSocket([Buffer.from('a')]);
        const transport = new SocketTransport();
        transport.attach(socket);

        const resultPromise = transport.readBytes(4);
        await new Promise((resolve) => setImmediate(resolve));
        socket.chunks.push(Buffer.from('bc'));
        socket.emit('readable');
        await new Promise((resolve) => setImmediate(resolve));
        socket.chunks.push(Buffer.from('d'));
        socket.emit('readable');

        await expect(resultPromise).resolves.toEqual(Buffer.from('abcd'));
    });

    test('flushes unread buffered data back to the stream', async () => {
        const socket = new FakeReadableSocket([Buffer.from('abcdef')]);
        const transport = new SocketTransport();
        transport.attach(socket);

        await expect(transport.readBytes(2)).resolves.toEqual(Buffer.from('ab'));
        transport.flushUnreadToStream();
        expect(socket.unshifted).toEqual([Buffer.from('cdef')]);
        expect(transport.bufferedLength()).toBe(0);
    });

    test('rejects invalid read lengths before touching the stream', async () => {
        const socket = new FakeReadableSocket([Buffer.from('data')]);
        const transport = new SocketTransport();
        transport.attach(socket);

        await expect(transport.readBytes(-1)).rejects.toThrow(/Invalid backend protocol length/);
        await expect(transport.readBytes(10_000_001)).rejects.toThrow(/maximum supported/);
        expect(socket.chunks).toHaveLength(1);
    });

    test('rejects EOF and removes temporary listeners', async () => {
        const socket = new FakeReadableSocket();
        const transport = new SocketTransport();
        transport.attach(socket);

        const resultPromise = transport.readBytes(1);
        await new Promise((resolve) => setImmediate(resolve));
        socket.emit('end');

        await expect(resultPromise).rejects.toThrow('Socket closed/ended during read');
        expect(socket.listenerCount('readable')).toBe(0);
        expect(socket.listenerCount('error')).toBe(0);
        expect(socket.listenerCount('end')).toBe(0);
        expect(socket.listenerCount('close')).toBe(0);
    });
});
