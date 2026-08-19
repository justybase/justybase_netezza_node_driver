const { Readable } = require('stream');

const { ExternalTableHandler } = require('../dist/cjs/external/ExternalTableHandler');
const { ExtabSock } = require('../dist/cjs/protocol/constants');

function createImportInput(filename) {
    const filenameBuf = Buffer.from(`${filename}\0`, 'utf8');
    const input = Buffer.alloc(8 + filenameBuf.length + 12);
    let offset = 8;

    filenameBuf.copy(input, offset);
    offset += filenameBuf.length;
    input.writeInt32BE(1, offset);
    offset += 4;
    input.writeInt32BE(1, offset);
    offset += 4;
    input.writeInt32BE(64, offset);

    return input;
}

function createIo(filename, stream, { hasImportStream = true, write = null } = {}) {
    const input = createImportInput(filename);
    let inputOffset = 0;
    const writes = [];
    const events = [];

    return {
        writes,
        events,
        readBytes: async (length) => {
            const value = input.subarray(inputOffset, inputOffset + length);
            inputOffset += length;
            return value;
        },
        readInt32: async () => {
            const value = input.readInt32BE(inputOffset);
            inputOffset += 4;
            return value;
        },
        write: write || (async (data) => {
            writes.push(Buffer.from(data));
        }),
        emit: (event, ...args) => {
            events.push({ event, args });
            return true;
        },
        getExportStream: () => null,
        setExportStream: () => {},
        hasImportStream: () => hasImportStream,
        getImportStream: () => stream,
    };
}

describe('ExternalTableHandler virtual imports', () => {
    test('sends all buffered virtual stream data before DONE', async () => {
        const filename = 'virtual://unit-test';
        const first = Buffer.from('1|First\n');
        const second = Buffer.from('2|Second\n');
        const stream = Readable.from([first, second]);
        stream.byteLength = first.length + second.length;
        const io = createIo(filename, stream);

        await new ExternalTableHandler(io).handleImport();

        expect(io.writes[0]).toEqual(Buffer.from([0, 0, 0, 1]));
        expect(io.writes.slice(1)).toEqual([
            Buffer.from([0, 0, 0, ExtabSock.DATA, 0, 0, 0, first.length]),
            first,
            Buffer.from([0, 0, 0, ExtabSock.DATA, 0, 0, 0, second.length]),
            second,
            Buffer.from([0, 0, 0, ExtabSock.DONE]),
        ]);

        expect(io.events.map(({ event, args }) => [event, args[0]])).toEqual([
            ['importProgress', {
                bytesSent: first.length,
                totalSize: first.length + second.length,
                percentComplete: Math.round((first.length / (first.length + second.length)) * 100),
            }],
            ['importProgress', {
                bytesSent: first.length + second.length,
                totalSize: first.length + second.length,
                percentComplete: 100,
            }],
        ]);
    });

    test('does not overlap writes while applying backpressure', async () => {
        const filename = 'virtual://backpressure-test';
        const stream = Readable.from([Buffer.from('a'), Buffer.from('b')]);
        let inFlight = 0;
        let maxInFlight = 0;
        const io = createIo(filename, stream, {
            write: async (data) => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setImmediate(resolve));
                inFlight -= 1;
                io.writes.push(Buffer.from(data));
            },
        });

        await new ExternalTableHandler(io).handleImport();

        expect(maxInFlight).toBe(1);
        expect(io.writes.at(-1)).toEqual(Buffer.from([0, 0, 0, ExtabSock.DONE]));
    });

    test('sends ERROR and does not send DONE when the virtual stream fails', async () => {
        const filename = 'virtual://error-test';
        const stream = new Readable({
            read() {
                this.destroy(new Error('virtual stream failed'));
            },
        });
        const io = createIo(filename, stream);

        await expect(new ExternalTableHandler(io).handleImport()).rejects.toThrow('virtual stream failed');

        expect(io.writes[0]).toEqual(Buffer.from([0, 0, 0, 1]));
        expect(io.writes[1]).toEqual(Buffer.from([0, 0, 0, ExtabSock.ERROR]));
        expect(io.writes[2]).toEqual(Buffer.from([0, 21]));
        expect(io.writes[3]).toEqual(Buffer.from('virtual stream failed'));
        expect(io.writes).not.toContainEqual(Buffer.from([0, 0, 0, ExtabSock.DONE]));
    });
});
