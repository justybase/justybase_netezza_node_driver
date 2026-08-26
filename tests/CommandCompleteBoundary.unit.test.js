const { NzDataReader } = require('../dist/cjs/NzDataReader');

const INT_COLUMN = { name: 'value', typeOid: 23, typeMod: -1, typeLen: 4 };

class MockNzCommand {
    constructor() {
        this._cachedRowDescription = null;
        this._notices = [];
    }
}

function createDeferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function* createMockGenerator(items) {
    for (const item of items) {
        yield item;
    }
}

function createReader(items, options = {}) {
    return new NzDataReader(
        options.command || new MockNzCommand(),
        createMockGenerator(items),
        options.columns || [INT_COLUMN],
        null,
        options.releaseCallback || null,
        options.initialNextItem || null
    );
}

describe('NzDataReader CommandComplete result boundaries', () => {
    test('read resolves at CommandComplete without waiting for ReadyForQuery', async () => {
        const readyForQuery = createDeferred();
        let releaseCount = 0;

        async function* delayedReadyGenerator() {
            yield { type: 'CommandComplete' };
            await readyForQuery.promise;
            yield { type: 'ReadyForQuery' };
        }

        const reader = new NzDataReader(
            new MockNzCommand(),
            delayedReadyGenerator(),
            [INT_COLUMN],
            null,
            () => {
                releaseCount++;
            },
            { type: 'DataRow', row: [7] }
        );

        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(7);
        await expect(reader.read()).resolves.toBe(false);
        expect(releaseCount).toBe(0);

        let closeSettled = false;
        const closePromise = reader.close().then(() => {
            closeSettled = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(closeSettled).toBe(false);
        expect(releaseCount).toBe(0);

        readyForQuery.resolve();
        await closePromise;
        expect(releaseCount).toBe(1);

        // Closing an already closed reader must not release the connection twice.
        await reader.close();
        expect(releaseCount).toBe(1);
    });

    test('async iteration closes and drains after natural CommandComplete completion', async () => {
        const readyForQuery = createDeferred();
        let releaseCount = 0;

        async function* delayedReadyGenerator() {
            yield { type: 'CommandComplete' };
            await readyForQuery.promise;
            yield { type: 'ReadyForQuery' };
        }

        const reader = new NzDataReader(
            new MockNzCommand(),
            delayedReadyGenerator(),
            [INT_COLUMN],
            null,
            () => {
                releaseCount++;
            },
            { type: 'DataRow', row: [7] }
        );

        const rowsPromise = (async () => {
            const rows = [];
            for await (const row of reader) {
                rows.push(row);
            }
            return rows;
        })();

        await new Promise((resolve) => setImmediate(resolve));
        expect(reader.isClosed).toBe(true);
        expect(releaseCount).toBe(0);

        readyForQuery.resolve();
        await expect(rowsPromise).resolves.toEqual([{ value: 7 }]);
        expect(releaseCount).toBe(1);

        await reader.close();
        expect(releaseCount).toBe(1);
    });

    test('early async-iteration exit closes and drains the reader', async () => {
        let sawReadyForQuery = false;
        let releaseCount = 0;

        async function* generator() {
            yield { type: 'DataRow', row: [8] };
            yield { type: 'CommandComplete' };
            sawReadyForQuery = true;
            yield { type: 'ReadyForQuery' };
        }

        const reader = new NzDataReader(
            new MockNzCommand(),
            generator(),
            [INT_COLUMN],
            null,
            () => {
                releaseCount++;
            },
            { type: 'DataRow', row: [7] }
        );

        for await (const row of reader) {
            expect(row.value).toBe(7);
            break;
        }

        expect(reader.isClosed).toBe(true);
        expect(sawReadyForQuery).toBe(true);
        expect(releaseCount).toBe(1);
    });

    test('repeated read calls stay on the completed result until nextResult', async () => {
        const command = new MockNzCommand();
        const reader = createReader(
            [
                { type: 'CommandComplete' },
                { type: 'NoticeResponse', message: 'between results' },
                { type: 'RowDescription', columns: [INT_COLUMN] },
                { type: 'DataRow', row: [2] },
                { type: 'CommandComplete' },
                { type: 'ReadyForQuery' },
            ],
            { command, initialNextItem: { type: 'DataRow', row: [1] } }
        );

        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(1);
        expect(await reader.read()).toBe(false);
        expect(await reader.read()).toBe(false);
        expect(command._notices).toEqual([]);

        expect(await reader.nextResult()).toBe(true);
        expect(command._notices).toEqual(['between results']);
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(2);
        expect(await reader.read()).toBe(false);
        expect(await reader.nextResult()).toBe(false);
    });

    test('preserves an empty result between two non-empty results', async () => {
        const reader = createReader(
            [
                { type: 'CommandComplete' },
                { type: 'RowDescription', columns: [INT_COLUMN] },
                { type: 'CommandComplete' },
                { type: 'RowDescription', columns: [INT_COLUMN] },
                { type: 'DataRow', row: [3] },
                { type: 'CommandComplete' },
                { type: 'ReadyForQuery' },
            ],
            { initialNextItem: { type: 'DataRow', row: [1] } }
        );

        expect(await reader.read()).toBe(true);
        expect(await reader.read()).toBe(false);

        expect(await reader.nextResult()).toBe(true);
        expect(reader.hasRows).toBe(false);
        expect(await reader.read()).toBe(false);

        expect(await reader.nextResult()).toBe(true);
        expect(reader.hasRows).toBe(true);
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(3);
        expect(await reader.read()).toBe(false);
        expect(await reader.nextResult()).toBe(false);
    });

    test('skips non-row CommandComplete messages while seeking the next result', async () => {
        const reader = createReader(
            [
                { type: 'CommandComplete' },
                { type: 'CommandComplete' },
                { type: 'CommandComplete' },
                { type: 'RowDescription', columns: [INT_COLUMN] },
                { type: 'DataRow', row: [9] },
                { type: 'CommandComplete' },
                { type: 'ReadyForQuery' },
            ],
            { initialNextItem: { type: 'DataRow', row: [1] } }
        );

        expect(await reader.read()).toBe(true);
        expect(await reader.read()).toBe(false);
        expect(await reader.nextResult()).toBe(true);
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(9);
    });

    test('nextResult drains unread rows from the current result', async () => {
        const reader = createReader(
            [
                { type: 'DataRow', row: [2] },
                { type: 'DataRow', row: [3] },
                { type: 'CommandComplete' },
                { type: 'RowDescription', columns: [INT_COLUMN] },
                { type: 'DataRow', row: [10] },
                { type: 'CommandComplete' },
                { type: 'ReadyForQuery' },
            ],
            { initialNextItem: { type: 'DataRow', row: [1] } }
        );

        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(1);
        expect(await reader.nextResult()).toBe(true);
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(10);
    });

    test('nextResult before the first read skips the complete current result', async () => {
        const reader = createReader(
            [
                { type: 'DataRow', row: [2] },
                { type: 'DataRow', row: [3] },
                { type: 'CommandComplete' },
                { type: 'RowDescription', columns: [INT_COLUMN] },
                { type: 'DataRow', row: [10] },
                { type: 'CommandComplete' },
                { type: 'ReadyForQuery' },
            ],
            { initialNextItem: { type: 'DataRow', row: [1] } }
        );

        expect(await reader.nextResult()).toBe(true);
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(10);
        expect(await reader.read()).toBe(false);
        expect(await reader.nextResult()).toBe(false);
    });

    test('nextResult handles RowDescriptionStandard and preserves nullability', async () => {
        const reader = createReader(
            [
                { type: 'CommandComplete' },
                {
                    type: 'RowDescriptionStandard',
                    desc: { fieldNullAllowed: [false] },
                },
                { type: 'DataRow', row: [2] },
                { type: 'CommandComplete' },
                { type: 'ReadyForQuery' },
            ],
            { initialNextItem: { type: 'DataRow', row: [1] } }
        );

        expect(await reader.read()).toBe(true);
        expect(await reader.read()).toBe(false);
        expect(await reader.nextResult()).toBe(true);
        expect(reader.hasRows).toBe(true);
        expect(reader.getSchemaTable().Rows[0].AllowDBNull).toBe(false);
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(2);
        expect(await reader.read()).toBe(false);
        expect(await reader.nextResult()).toBe(false);
    });

    test('close drains messages after CommandComplete before releasing the reader', async () => {
        const readyForQuery = createDeferred();
        let releaseCount = 0;
        const command = new MockNzCommand();

        async function* delayedReadyGenerator() {
            yield { type: 'CommandComplete' };
            yield { type: 'NoticeResponse', message: 'during close' };
            yield { type: 'RowDescription', columns: [INT_COLUMN] };
            yield { type: 'DataRow', row: [2] };
            yield { type: 'CommandComplete' };
            await readyForQuery.promise;
            yield { type: 'ReadyForQuery' };
        }

        const reader = new NzDataReader(
            command,
            delayedReadyGenerator(),
            [INT_COLUMN],
            null,
            () => {
                releaseCount++;
            },
            { type: 'DataRow', row: [1] }
        );

        expect(await reader.read()).toBe(true);
        expect(await reader.read()).toBe(false);

        const closePromise = reader.close();
        await new Promise((resolve) => setImmediate(resolve));
        expect(releaseCount).toBe(0);
        expect(command._notices).toEqual(['during close']);

        readyForQuery.resolve();
        await closePromise;
        expect(releaseCount).toBe(1);
        await reader.close();
        expect(releaseCount).toBe(1);
    });

    test('read remains false after close and after the final result', async () => {
        const reader = createReader([
            { type: 'ReadyForQuery' },
        ]);

        expect(await reader.read()).toBe(false);
        expect(reader.isClosed).toBe(false);
        await reader.close();
        expect(reader.isClosed).toBe(true);
        expect(await reader.read()).toBe(false);
        expect(await reader.nextResult()).toBe(false);
    });

    test('surfaces an error encountered while moving to the next result', async () => {
        const reader = createReader(
            [
                { type: 'CommandComplete' },
                { type: 'ErrorResponse', message: 'next statement failed' },
                { type: 'ReadyForQuery' },
            ],
            { initialNextItem: { type: 'DataRow', row: [1] } }
        );

        expect(await reader.read()).toBe(true);
        expect(await reader.read()).toBe(false);
        await expect(reader.nextResult()).rejects.toThrow('next statement failed');
        await reader.close();
    });
});
