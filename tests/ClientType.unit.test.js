const { EventEmitter } = require('events');

const { ClientTypeId, NzConnection } = require('../dist/cjs');
const { Handshake } = require('../dist/cjs/Handshake');

class HandshakeSocket extends EventEmitter {
    constructor(responseCount) {
        super();
        this.destroyed = false;
        this.writes = [];
        this._reads = [Buffer.alloc(responseCount, 'N')];
    }

    write(data) {
        this.writes.push(Buffer.from(data));
        return true;
    }

    read() {
        return this._reads.shift() || null;
    }

    unshift() {}
}

function handshakePackets(socket) {
    const wire = Buffer.concat(socket.writes);
    const packets = [];
    let offset = 0;

    while (offset < wire.length) {
        if (offset + 4 > wire.length) throw new Error('Incomplete handshake packet length');
        const length = wire.readInt32BE(offset);
        if (length < 6 || offset + length > wire.length) {
            throw new Error(`Invalid handshake packet length: ${length}`);
        }

        packets.push({
            opcode: wire.readInt16BE(offset + 4),
            payload: wire.subarray(offset + 6, offset + length),
        });
        offset += length;
    }

    return packets;
}

function clientTypePacket(socket) {
    const packet = handshakePackets(socket).find(({ opcode }) => opcode === 8);
    if (!packet) throw new Error('HSV2_CLIENT_TYPE packet was not sent');
    return packet;
}

describe('Netezza client type configuration', () => {
    test('exports the known client type identifiers, including Node', () => {
        expect(ClientTypeId).toMatchObject({
            Invalid: -1,
            None: 0,
            Sql: 1,
            SqlOdbc: 2,
            SqlJdbc: 3,
            Load: 4,
            Client: 5,
            Bnr: 6,
            Reclaim: 7,
            Unknown: 8,
            SqlOledb: 9,
            Internal: 10,
            SqlDotnet: 11,
            SqlGolang: 12,
            SqlPython: 13,
            Unknown2: 14,
            Node: 15,
        });
    });

    test('accepts the default and custom signed 16-bit client types', () => {
        const base = {
            host: 'localhost',
            database: 'db',
            user: 'user',
            password: 'password',
        };

        expect(() => new NzConnection(base)).not.toThrow();
        expect(() => new NzConnection({ ...base, clientType: 11 })).not.toThrow();
        expect(() => new NzConnection({ ...base, clientType: -32768 })).not.toThrow();
        expect(() => new NzConnection({ ...base, clientType: 32767 })).not.toThrow();
    });

    test.each([undefined, 11, 13, 15, 32767])(
        'sends client type %s in handshake v2',
        async (clientType) => {
            const socket = new HandshakeSocket(8);
            const handshake = new Handshake(socket, socket, 'host',
                clientType === undefined ? {} : { clientType });

            await handshake.connSendHandshakeVersion2(6, 'user');

            const packet = clientTypePacket(socket);
            expect(packet.payload.length).toBe(2);
            expect(packet.payload.readInt16BE(0)).toBe(clientType ?? ClientTypeId.Node);
        }
    );

    test.each([undefined, 11, 15])(
        'sends client type %s in handshake v4',
        async (clientType) => {
            const socket = new HandshakeSocket(12);
            const handshake = new Handshake(socket, socket, 'host',
                clientType === undefined ? {} : { clientType });

            await handshake.connSendHandshakeVersion4(6, 'user');

            const packet = clientTypePacket(socket);
            expect(packet.payload.length).toBe(2);
            expect(packet.payload.readInt16BE(0)).toBe(clientType ?? ClientTypeId.Node);
        }
    );

    test.each([Number.NaN, 1.5, -32769, 32768, Infinity])(
        'rejects invalid client type %s',
        (clientType) => {
            expect(() => new NzConnection({
                host: 'localhost',
                database: 'db',
                user: 'user',
                password: 'password',
                clientType,
            })).toThrow(RangeError);
        }
    );
});
