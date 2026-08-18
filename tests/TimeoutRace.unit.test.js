const { EventEmitter } = require('events');
const { NzConnection } = require('../dist/cjs/NzConnection');

/** Minimal socket stand-in: EventEmitter + the subset of net.Socket used by the driver. */
class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.destroyed = false;
    }

    destroy() {
        this.destroyed = true;
        this.emit('close');
    }

    end() {}

    write() {
        return true;
    }

    read() {
        return null;
    }

    unshift() {}

    setNoDelay() {}

    setTimeout() {}

    connect() {}

    removeAllListeners() {
        super.removeAllListeners();
    }
}

/** Socket whose 'close' event fires asynchronously, like a real net.Socket. */
class AsyncCloseSocket extends FakeSocket {
    destroy() {
        this.destroyed = true;
        queueMicrotask(() => this.emit('close'));
    }
}

/** Socket that can deliver protocol bytes after the fact (emits 'readable'). */
class QueuedSocket extends FakeSocket {
    constructor() {
        super();
        this._chunks = [];
    }

    push(buf) {
        this._chunks.push(buf);
        this.emit('readable');
    }

    read() {
        return this._chunks.length > 0 ? this._chunks.shift() : null;
    }
}

const RFQ_MESSAGE = Buffer.from([0x5a, 0x00, 0x00, 0x00, 0x05, 0x49]); // 'Z' + len 5 + status

function createConnection() {
    return new NzConnection({
        host: 'localhost',
        database: 'db',
        user: 'user',
        password: 'password',
    });
}

describe('NzConnection timeout cleanup', () => {
    test('cleans readable listeners from the original stream after connection close', async () => {
        const connection = createConnection();
        const stream = new EventEmitter();

        connection._stream = stream;
        connection._socket = { destroyed: false };
        const readPromise = connection._waitForReadable();

        // close() clears the connection's reference while the pending reader
        // is still waiting for the socket event.
        connection._stream = null;
        stream.emit('close');

        await expect(readPromise).rejects.toThrow('Socket closed/ended during read');
        expect(stream.listenerCount('close')).toBe(0);
        expect(stream.listenerCount('readable')).toBe(0);
        expect(stream.listenerCount('error')).toBe(0);
        expect(stream.listenerCount('end')).toBe(0);
    });

    test('close() waits for the active execution before nulling _stream', async () => {
        const connection = createConnection();
        const sock = new FakeSocket();
        sock.destroyed = true; // force the "already destroyed" close() branch
        connection._socket = sock;
        connection._stream = sock;

        let resolveExecution;
        connection._activeExecution = new Promise((resolve) => {
            resolveExecution = resolve;
        });

        const closePromise = connection.close();
        await new Promise((r) => setTimeout(r, 10));
        expect(connection._stream).not.toBeNull();

        resolveExecution();
        await closePromise;
        expect(connection._stream).toBeNull();
    });

    test('timeout -> executeReader rejection -> close() unwinds the reader without TypeError', async () => {
        const connection = createConnection();
        const sock = new FakeSocket();
        connection._socket = sock;
        connection._stream = sock;
        connection._connected = true;
        connection.commandTimeout = 0.05; // 50 ms
        // No backend ids: cancel() is a no-op and does not touch the socket.
        connection._backendProcessId = 0;
        connection._backendSecretKey = 0;

        const cmd = connection.createCommand('SELECT 1');
        const execPromise = cmd.executeReader();

        await expect(execPromise).rejects.toThrow('Command execution timeout');
        await connection.close();

        expect(connection._stream).toBeNull();
        expect(connection._socket).toBeNull();
        expect(connection._executing).toBe(false);
        expect(sock.listenerCount('readable')).toBe(0);
        expect(sock.listenerCount('close')).toBe(0);
        expect(sock.listenerCount('error')).toBe(0);
        expect(sock.listenerCount('end')).toBe(0);
    });

    test('close() with a live socket waits for the async close and still unwinds cleanly', async () => {
        const connection = createConnection();
        const sock = new AsyncCloseSocket();
        connection._socket = sock;
        connection._stream = sock;
        connection._connected = true;

        const readPromise = connection._waitForReadable();
        const closePromise = connection.close();

        // The socket 'close' event arrives asynchronously (microtask), so the
        // pending read rejects after close() has already nulled _stream.
        await closePromise;
        await expect(readPromise).rejects.toThrow('Socket closed/ended during read');
        expect(connection._stream).toBeNull();
        expect(sock.listenerCount('readable')).toBe(0);
        expect(sock.listenerCount('close')).toBe(0);
        expect(sock.listenerCount('error')).toBe(0);
        expect(sock.listenerCount('end')).toBe(0);
    });

    test('late-success after timeout closes the orphaned reader and releases _executing', async () => {
        const connection = createConnection();
        const sock = new QueuedSocket();
        connection._socket = sock;
        connection._stream = sock;
        connection._connected = true;
        connection.commandTimeout = 0.05; // 50 ms
        connection._backendProcessId = 0;
        connection._backendSecretKey = 0;

        const cmd = connection.createCommand('SELECT 1');
        const execPromise = cmd.executeReader();

        await expect(execPromise).rejects.toThrow('Command execution timeout');
        expect(connection._executing).toBe(true); // still unwinding

        // The server response lands after the timeout already rejected.
        setTimeout(() => sock.push(RFQ_MESSAGE), 80);
        await new Promise((r) => setTimeout(r, 200));

        // The orphaned reader must have been closed: _executing released,
        // connection still usable, no listeners left.
        expect(connection._executing).toBe(false);
        expect(connection._stream).not.toBeNull();
        expect(sock.listenerCount('readable')).toBe(0);
        expect(sock.listenerCount('close')).toBe(0);
        expect(sock.listenerCount('error')).toBe(0);
        expect(sock.listenerCount('end')).toBe(0);
    });

    test('reading from a closed connection throws a clean error, not a TypeError', async () => {
        const connection = createConnection();
        const sock = new FakeSocket();
        connection._socket = sock;
        connection._stream = sock;
        connection._connected = true;

        await connection.close();
        expect(connection._stream).toBeNull();

        await expect(connection._ensureBufferData(1)).rejects.toThrow('Connection is closed');
        expect(() => connection._feedBuffer(Buffer.alloc(1))).toThrow('Connection is closed');
    });

    test('close() is idempotent and safe to call multiple times', async () => {
        const connection = createConnection();
        const sock = new FakeSocket();
        connection._socket = sock;
        connection._stream = sock;
        connection._connected = true;

        await connection.close();
        await connection.close();
        expect(connection._stream).toBeNull();
    });
});