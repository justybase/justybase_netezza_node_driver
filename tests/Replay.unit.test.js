/**
 * Offline end-to-end tests over byte-exact appliance captures replayed by a
 * loopback server. `.nzreplay.gz` fixtures are shared with the C# reference
 * driver, `tests/fixtures/wire/*.bin` with the Rust driver.
 *
 * The golden digests and snapshots pin every decoded value together with its
 * JS type, so decoder/transport optimizations cannot silently change results.
 */
const { NzConnection } = require('../dist/cjs');
const { loadFixture, loadWireFixture } = require('./helpers/replay/NzReplayFixture');
const { NzReplayServer } = require('./helpers/replay/NzReplayServer');
const { ValueDigest, describeValue } = require('./helpers/replay/valueDigest');

const GOLDEN = {
    dimdate: '7540f1592e5508b75688cfd9ca43f1741cac448f7977e5de308de33f3d636a9f',
    fact200k: '74097a6061747a4892e90cfe4bde523a33513172318e2c81a92cdc07d71d52ec',
};

const WIRE_FIXTURES = [
    'dbos_types',
    'error',
    'multi_result',
    'notice',
    'null_matrix',
    'numeric_matrix',
    'text_types',
    'varchar_32767',
];

async function withReplay(fixture, options, fn) {
    const server = await new NzReplayServer(fixture, options).start();
    const connection = new NzConnection(server.connectionConfig());
    try {
        await connection.connect();
        await fn(connection, server);
    } finally {
        await connection.close();
        await server.stop();
    }
}

function describeColumns(reader) {
    const columns = [];
    for (let i = 0; i < reader.fieldCount; i++) {
        columns.push(`${reader.getName(i)}:${reader.getTypeName(i)}`);
    }
    return columns.join(',');
}

async function digestAll(connection, sql) {
    const reader = await connection.createCommand(sql).executeReader();
    const digest = new ValueDigest();
    const values = new Array(reader.fieldCount);
    let first = null;
    while (await reader.read()) {
        for (let i = 0; i < values.length; i++) values[i] = reader.getValue(i);
        if (first === null) first = values.slice();
        digest.addRow(values);
    }
    await reader.close();
    return { rows: digest.rows, fieldCount: values.length, digest: digest.digest(), first };
}

/** Readable transcript of every result set (or error) a statement produces. */
async function transcribe(connection, sql) {
    const lines = [];
    let reader;
    try {
        reader = await connection.createCommand(sql).executeReader();
        do {
            lines.push(`columns ${describeColumns(reader)}`);
            while (await reader.read()) {
                const values = [];
                for (let i = 0; i < reader.fieldCount; i++) {
                    const value = describeValue(reader.getValue(i));
                    values.push(value.length > 80 ? `${value.slice(0, 40)}…(${value.length})…${value.slice(-20)}` : value);
                }
                lines.push(`row ${values.join(' | ')}`);
            }
        } while (await reader.nextResult());
        await reader.close();
    } catch (error) {
        lines.push(`error ${error.message}`);
        if (reader) await reader.close().catch(() => {});
    }
    return lines;
}

describe('replay: C# .nzreplay fixtures', () => {
    test('dimdate decodes every value identically', async () => {
        const fixture = loadFixture('dimdate');
        await withReplay(fixture, {}, async (connection) => {
            const result = await digestAll(connection, fixture.query);
            expect(result.rows).toBe(fixture.expectedRows);
            expect(result.fieldCount).toBe(fixture.expectedColumns);
            expect(result.first.slice(0, 5)).toEqual([
                20050101,
                new Date('2005-01-01T00:00:00.000Z'),
                7,
                'Saturday',
                'Sábado',
            ]);
            expect(result.digest).toBe(GOLDEN.dimdate);
        });
    });

    test('fact200k decodes every value identically', async () => {
        const fixture = loadFixture('fact200k');
        await withReplay(fixture, {}, async (connection) => {
            const result = await digestAll(connection, fixture.query);
            expect(result.rows).toBe(fixture.expectedRows);
            expect(result.fieldCount).toBe(fixture.expectedColumns);
            expect(result.first).toEqual([1, 20101228, new Date('2010-12-28T00:00:00.000Z'), '0.320000', '0', '0', '875']);
            expect(result.digest).toBe(GOLDEN.fact200k);
        });
    });

    test.each([1, 7, 4096])('dimdate is identical when the server writes %i-byte chunks', async (chunkSize) => {
        const fixture = loadFixture('dimdate');
        await withReplay(fixture, { chunkSize }, async (connection) => {
            const result = await digestAll(connection, fixture.query);
            expect(result.rows).toBe(fixture.expectedRows);
            expect(result.digest).toBe(GOLDEN.dimdate);
        });
    });

    test.each([1, 10])('connection is reusable after closing a reader after %i row(s)', async (rowsToRead) => {
        const fixture = loadFixture('dimdate');
        await withReplay(fixture, {}, async (connection) => {
            const reader = await connection.createCommand(fixture.query).executeReader();
            for (let i = 0; i < rowsToRead; i++) expect(await reader.read()).toBe(true);
            expect(reader.getValue(0)).toBe(20050101 + rowsToRead - 1);
            await reader.close();

            const result = await digestAll(connection, fixture.query);
            expect(result.digest).toBe(GOLDEN.dimdate);
        });
    });

    test('query() returns row objects for the whole result', async () => {
        const fixture = loadFixture('dimdate');
        await withReplay(fixture, {}, async (connection) => {
            const { rows, rowCount } = await connection.query(fixture.query);
            expect(rowCount).toBe(fixture.expectedRows);
            expect(rows).toHaveLength(fixture.expectedRows);
            expect(rows[0].DATEKEY).toBe(20050101);
            expect(rows[rows.length - 1].ENGLISHDAYNAMEOFWEEK).toEqual(expect.any(String));
        });
    });
});

describe('replay: Rust wire fixtures', () => {
    test.each(WIRE_FIXTURES)('%s', async (name) => {
        const fixture = loadWireFixture(name);
        await withReplay(fixture, {}, async (connection) => {
            const transcript = [];
            for (const sql of fixture.statements) {
                transcript.push(`> ${sql.length > 120 ? `${sql.slice(0, 120)}…` : sql}`);
                transcript.push(...(await transcribe(connection, sql)));
            }
            expect(transcript).toMatchSnapshot();
        });
    });

    test.each([1, 3])('numeric_matrix is identical with %i-byte chunks', async (chunkSize) => {
        const fixture = loadWireFixture('numeric_matrix');
        const run = async (options) => {
            const transcript = [];
            await withReplay(fixture, options, async (connection) => {
                for (const sql of fixture.statements) transcript.push(...(await transcribe(connection, sql)));
            });
            return transcript;
        };
        expect(await run({ chunkSize })).toEqual(await run({}));
    });
});
