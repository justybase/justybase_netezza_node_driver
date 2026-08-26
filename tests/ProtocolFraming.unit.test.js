const { EventEmitter } = require('events');
const { NzConnection } = require('../dist/cjs/NzConnection');
const { BackendMessageCode } = require('../dist/cjs/protocol/constants');

class QueuedSocket extends EventEmitter {
    constructor(chunks) {
        super();
        this.destroyed = false;
        this.chunks = chunks.map((chunk) => Buffer.from(chunk));
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
        if (this.onWrite) this.onWrite(data);
        return true;
    }

    destroy() {
        this.destroyed = true;
        this.emit('close');
    }
}

function int32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value, 0);
    return buffer;
}

// The Netezza response path consumes a four-byte response header and then a
// second length before payload-bearing messages. RowStandard is special: its
// shared header is not a total frame length; the DBOS header contains the row
// length used to consume the payload.
function payloadMessage(type, payload, declaredLength = payload.length) {
    return Buffer.concat([Buffer.from([type]), Buffer.alloc(4), int32(declaredLength), payload]);
}

function readyMessage() {
    return Buffer.concat([Buffer.from([BackendMessageCode.ReadyForQuery]), Buffer.alloc(4)]);
}

function rowDescription() {
    const body = Buffer.alloc(2 + 6 + 4 + 2 + 4 + 1);
    let offset = 0;
    body.writeUInt16BE(1, offset);
    offset += 2;
    Buffer.from('value\0').copy(body, offset);
    offset += 6;
    body.writeInt32BE(23, offset);
    offset += 4;
    body.writeInt16BE(4, offset);
    offset += 2;
    body.writeInt32BE(-1, offset);
    offset += 4;
    body[offset] = 0;
    return body;
}

function dataRow(value = '42') {
    const valueBytes = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([0x80]), int32(valueBytes.length + 4), valueBytes]);
}

function binaryDescriptor(fieldOffset = 3) {
    const data = Buffer.alloc(36 + 36 + 8);
    let offset = 0;
    for (const value of [1, 1, 8, 4, 1, 0, 3, 7, 1]) {
        data.writeInt32BE(value, offset);
        offset += 4;
    }
    for (const value of [3, 4, 4, fieldOffset, 0, 0, 1, 4, 0]) {
        data.writeInt32BE(value, offset);
        offset += 4;
    }
    data.writeInt32BE(0, offset);
    data.writeInt32BE(0, offset + 4);
    return data;
}

function binaryRow(value = 42) {
    const row = Buffer.alloc(7);
    row[2] = 0; // one-column null bitmap: the value is present
    row.writeInt32LE(value, 3);
    return row;
}

function rowStandardMessage(row, sharedHeaderValue = 1, declaredRowLength = row.length) {
    return Buffer.concat([
        Buffer.from([BackendMessageCode.RowStandard]),
        int32(sharedHeaderValue),
        int32(0), // DBOS row header word
        int32(declaredRowLength),
        row,
    ]);
}

function createConnection(bytes, { oneByteChunks = false } = {}) {
    const chunks = oneByteChunks
        ? [...bytes].map((byte) => Buffer.from([byte]))
        : [bytes];
    const socket = new QueuedSocket(chunks);
    const connection = new NzConnection({
        host: 'localhost',
        database: 'db',
        user: 'user',
        password: 'password',
    });
    connection._socket = socket;
    connection._stream = socket;
    connection._connected = true;
    return { connection, socket };
}

async function collectResponse(connection) {
    const command = connection.createCommand('SELECT 42');
    const values = [];
    for await (const item of connection._responseGenerator(command)) {
        values.push(item);
    }
    return { command, values };
}

describe('Netezza protocol framing', () => {
    test('parses a fragmented text result without losing message boundaries', async () => {
        const bytes = Buffer.concat([
            payloadMessage(BackendMessageCode.RowDescription, rowDescription()),
            payloadMessage(BackendMessageCode.DataRow, dataRow()),
            payloadMessage(BackendMessageCode.CommandComplete, Buffer.from('SELECT 1\0')),
            readyMessage(),
        ]);
        const { connection } = createConnection(bytes, { oneByteChunks: true });

        const { command, values } = await collectResponse(connection);
        expect(values.map((item) => item.type)).toEqual([
            'RowDescription',
            'DataRow',
            'CommandComplete',
            'ReadyForQuery',
        ]);
        expect(values[1].row).toEqual([42]);
        expect(command._recordsAffected).toBe(1);
    });

    test('parses a binary RowStandard result and batches the next row', async () => {
        const bytes = Buffer.concat([
            payloadMessage(BackendMessageCode.RowDescriptionStandard, binaryDescriptor()),
            rowStandardMessage(binaryRow(42)),
            rowStandardMessage(binaryRow(43)),
            readyMessage(),
        ]);
        const { connection } = createConnection(bytes);

        const { values } = await collectResponse(connection);
        expect(values.map((item) => item.type)).toEqual([
            'RowDescriptionStandard',
            'DataRow',
            'DataRow',
            'ReadyForQuery',
        ]);
        expect(values.filter((item) => item.type === 'DataRow').map((item) => item.row)).toEqual([[42], [43]]);
        expect(connection.diagnostics.tryReadDbosBatchRows).toBe(1);
    });

    test('rejects a binary field offset that escapes the RowStandard payload', async () => {
        const { connection } = createConnection(
            Buffer.concat([
                payloadMessage(BackendMessageCode.RowDescriptionStandard, binaryDescriptor(100)),
                rowStandardMessage(binaryRow()),
                readyMessage(),
            ])
        );

        await expect(collectResponse(connection)).rejects.toThrow(/fixed field 0 extends beyond the row/);
    });

    test.each([
        ['negative', -1],
        ['oversized', 10_000_001],
    ])('rejects a %s length-prefixed payload', async (_name, declaredLength) => {
        const { connection } = createConnection(
            payloadMessage(BackendMessageCode.CommandComplete, Buffer.alloc(0), declaredLength)
        );

        await expect(collectResponse(connection)).rejects.toThrow(/Invalid backend protocol length/);
    });

    test('rejects a truncated row description instead of creating partial metadata', async () => {
        const body = Buffer.from([0, 1, 0x76]);
        const { connection } = createConnection(payloadMessage(BackendMessageCode.RowDescription, body));

        await expect(collectResponse(connection)).rejects.toThrow(/RowDescription payload/);
    });

    test('rejects a DataRow field that extends beyond its payload', async () => {
        const malformedRow = Buffer.concat([Buffer.from([0x80]), int32(100), Buffer.from('x')]);
        const bytes = Buffer.concat([
            payloadMessage(BackendMessageCode.RowDescription, rowDescription()),
            payloadMessage(BackendMessageCode.DataRow, malformedRow),
        ]);
        const { connection } = createConnection(bytes);

        await expect(collectResponse(connection)).rejects.toThrow(/DataRow payload/);
    });

    test('rejects a zero RowStandard payload length before moving the buffer cursor', async () => {
        const bytes = Buffer.concat([
            Buffer.from([BackendMessageCode.RowStandard]),
            int32(1),
            int32(0),
            int32(0),
        ]);
        const { connection } = createConnection(bytes);

        await expect(collectResponse(connection)).rejects.toThrow(/rowStandardPayload/);
    });

    test('rejects a negative RowStandard payload length', async () => {
        const bytes = Buffer.concat([
            Buffer.from([BackendMessageCode.RowStandard]),
            int32(1),
            int32(0),
            int32(-1),
        ]);
        const { connection } = createConnection(bytes);

        await expect(collectResponse(connection)).rejects.toThrow(/rowStandardPayload/);
    });

    test('does not silently swallow invalid unknown-message lengths', async () => {
        const bytes = payloadMessage(0x7f, Buffer.alloc(0), -1);
        const { connection } = createConnection(bytes);

        await expect(collectResponse(connection)).rejects.toThrow(/unknownMessagePayload/);
    });

    test('drains a valid orphaned response before the next command', async () => {
        const bytes = Buffer.concat([
            payloadMessage(BackendMessageCode.CommandComplete, Buffer.from('SELECT 1\0')),
            readyMessage(),
        ]);
        const { connection } = createConnection(bytes);

        await expect(connection._ensureProtocolSynced('SELECT 2')).resolves.toBeUndefined();
        expect(connection._intBufEnd - connection._intBufStart).toBe(0);
    });

    test('rejects an orphaned RowStandard frame with inconsistent lengths', async () => {
        const bytes = Buffer.concat([
            Buffer.from([BackendMessageCode.RowStandard]),
            int32(10),
            int32(0),
            int32(1),
            Buffer.from([0]),
        ]);
        const { connection } = createConnection(bytes);

        await expect(connection._ensureProtocolSynced('SELECT 2')).rejects.toThrow(/out of sync/);
    });

    test('marks the connection unusable after a malformed response payload', async () => {
        const { connection, socket } = createConnection(Buffer.alloc(0));
        socket.onWrite = () => {
            socket.chunks.push(payloadMessage(BackendMessageCode.RowDescription, Buffer.from([0, 1, 0x76])));
            socket.emit('readable');
        };

        await expect(connection._doExecute(connection.createCommand('SELECT 1'))).rejects.toThrow(
            /RowDescription payload/
        );
        expect(connection._protocolFaulted).toBe(true);
        expect(socket.destroyed).toBe(true);
        await expect(connection._doExecute(connection.createCommand('SELECT 2'))).rejects.toThrow(
            /protocol is invalid.*reconnect is required/
        );
    });

    test('marks the connection unusable when a malformed row arrives after executeReader returns', async () => {
        const malformedRow = Buffer.concat([Buffer.from([0x80]), int32(100), Buffer.from('x')]);
        const { connection, socket } = createConnection(Buffer.alloc(0));
        socket.onWrite = () => {
            socket.chunks.push(
                Buffer.concat([
                    payloadMessage(BackendMessageCode.RowDescription, rowDescription()),
                    payloadMessage(BackendMessageCode.DataRow, dataRow('1')),
                    payloadMessage(BackendMessageCode.DataRow, malformedRow),
                ])
            );
            socket.emit('readable');
        };

        const reader = await connection.createCommand('SELECT 1').executeReader();
        await expect(reader.read()).resolves.toBe(true);
        expect(reader.getValue(0)).toBe(1);
        await expect(reader.read()).rejects.toThrow(/DataRow payload/);
        expect(connection._protocolFaulted).toBe(true);
        await reader.close();
        await expect(connection._doExecute(connection.createCommand('SELECT 2'))).rejects.toThrow(/reconnect is required/);
    });

    test('does not poison a connection for a valid SQL ErrorResponse', async () => {
        const { connection, socket } = createConnection(Buffer.alloc(0));
        socket.onWrite = () => {
            socket.chunks.push(
                Buffer.concat([
                    payloadMessage(BackendMessageCode.ErrorResponse, Buffer.from('Mexpected failure\0\0')),
                    readyMessage(),
                ])
            );
            socket.emit('readable');
        };

        await expect(connection._doExecute(connection.createCommand('SELECT 1'))).rejects.toThrow('expected failure');
        expect(connection._protocolFaulted).toBe(false);
        await connection.close();
    });
});
