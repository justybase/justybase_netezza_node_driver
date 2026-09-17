/**
 * Offline unit tests for NzPool release behaviour:
 *  - F2: a connection returned with an open transaction is rolled back before
 *    it can be handed to the next checkout;
 *  - F3: a SQL-level failure (`NzDatabaseError`) keeps the session, while a
 *    protocol fault or socket error still destroys the connection.
 */

const { NzPool } = require('../dist/cjs/NzPool');
const { NzConnection } = require('../dist/cjs/NzConnection');
const { NzDatabaseError } = require('../dist/cjs/errors/NzDatabaseError');
const { NzProtocolError } = require('../dist/cjs/protocol/ProtocolLength');

const baseConfig = {
    host: 'localhost',
    database: 'db',
    user: 'user',
    password: 'password',
};

function sqlError(message = 'ERROR:  relation does not exist DB.ADMIN.NO_SUCH') {
    return new NzDatabaseError({ message, code: '42P01', raw: message });
}

let connectSpy;
let closeSpy;
let rollbackSpy;
let inTransaction = false;

beforeEach(() => {
    connectSpy = jest.spyOn(NzConnection.prototype, 'connect').mockResolvedValue(undefined);
    closeSpy = jest.spyOn(NzConnection.prototype, 'close').mockResolvedValue(undefined);
    rollbackSpy = jest.spyOn(NzConnection.prototype, 'rollback').mockResolvedValue(undefined);
    inTransaction = false;
    jest.spyOn(NzConnection.prototype, 'inTransaction', 'get').mockImplementation(() => inTransaction);
});

afterEach(() => {
    jest.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('NzPool rollback on release (F2)', () => {
    test('rolls back an open transaction before the client becomes idle', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        const { release } = await pool.connect();

        inTransaction = true;
        release();

        // The connection must not be reusable until the rollback has finished.
        expect(rollbackSpy).toHaveBeenCalledTimes(1);
        expect(pool.idleCount).toBe(0);
        expect(pool.totalCount).toBe(1);

        await flush();
        expect(pool.idleCount).toBe(1);
        expect(pool.totalCount).toBe(1);

        await pool.end();
    });

    test('does not roll back a connection that is not inside a transaction', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        const { release } = await pool.connect();

        release();

        expect(rollbackSpy).not.toHaveBeenCalled();
        expect(pool.idleCount).toBe(1);

        await pool.end();
    });

    test('a queued checkout waits for the release rollback to finish', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        const first = await pool.connect();

        let finishRollback;
        rollbackSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishRollback = resolve;
                })
        );

        inTransaction = true;
        first.release();

        const queued = pool.connect();
        let queuedResolved = false;
        void queued.then(() => {
            queuedResolved = true;
        });

        await flush();
        expect(rollbackSpy).toHaveBeenCalledTimes(1);
        // Still inside the rollback: the connection has not been handed over.
        expect(queuedResolved).toBe(false);

        finishRollback();
        const second = await queued;
        expect(queuedResolved).toBe(true);
        // Same session, but its transaction has been closed.
        expect(second.client).toBe(first.client);

        inTransaction = false;
        second.release();
        await pool.end();
    });

    test('removes the client when the release rollback fails', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        pool.on('error', () => {});
        const { release } = await pool.connect();

        rollbackSpy.mockRejectedValueOnce(new Error('ROLLBACK failed'));
        inTransaction = true;
        release();

        await flush();
        await flush();

        expect(pool.totalCount).toBe(0);
        expect(pool.idleCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        await pool.end();
    });

    test('rollbackOnRelease: false keeps the previous behaviour', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0, rollbackOnRelease: false });
        const { release } = await pool.connect();

        inTransaction = true;
        release();

        expect(rollbackSpy).not.toHaveBeenCalled();
        expect(pool.idleCount).toBe(1);

        await pool.end();
    });

    test('the connection leaves the transaction flag to the client, not the pool', async () => {
        // The pool must not guess the state: it only reads `inTransaction`.
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        const { client, release } = await pool.connect();

        expect(client.inTransaction).toBe(false);
        release();
        expect(rollbackSpy).not.toHaveBeenCalled();

        await pool.end();
    });
});

describe('NzPool error classification on release (F3)', () => {
    test('query(): a SQL error keeps the connection in the pool', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        jest.spyOn(NzConnection.prototype, 'query').mockRejectedValueOnce(sqlError());

        await expect(pool.query('SELECT * FROM NO_SUCH')).rejects.toMatchObject({
            code: '42P01',
            message: expect.stringMatching(/relation does not exist/),
        });

        expect(pool.totalCount).toBe(1);
        expect(pool.idleCount).toBe(1);
        expect(closeSpy).not.toHaveBeenCalled();

        await pool.end();
    });

    test('query(): a protocol fault destroys the connection', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        jest.spyOn(NzConnection.prototype, 'query').mockRejectedValueOnce(
            new NzProtocolError('Invalid backend protocol length')
        );

        await expect(pool.query('SELECT 1')).rejects.toThrow(/protocol length/);

        expect(pool.totalCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        await pool.end();
    });

    test('query(): a socket failure destroys the connection', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        jest.spyOn(NzConnection.prototype, 'query').mockRejectedValueOnce(new Error('ECONNRESET'));

        await expect(pool.query('SELECT 1')).rejects.toThrow('ECONNRESET');

        expect(pool.totalCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        await pool.end();
    });

    test('executeNonQuery(): a SQL error keeps the connection in the pool', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        jest.spyOn(NzConnection.prototype, 'execute').mockRejectedValueOnce(sqlError('ERROR:  syntax error'));

        await expect(pool.executeNonQuery('SELEC 1')).rejects.toMatchObject({
            code: '42P01',
            message: expect.stringMatching(/syntax error/),
        });

        expect(pool.totalCount).toBe(1);
        expect(pool.idleCount).toBe(1);
        expect(closeSpy).not.toHaveBeenCalled();

        await pool.end();
    });

    test('executeNonQuery(): a protocol fault destroys the connection', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        jest.spyOn(NzConnection.prototype, 'execute').mockRejectedValueOnce(new NzProtocolError('bad framing'));

        await expect(pool.executeNonQuery('SELECT 1')).rejects.toThrow('bad framing');

        expect(pool.totalCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        await pool.end();
    });

    test('a non-Error rejection is still classified as destructive', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        jest.spyOn(NzConnection.prototype, 'query').mockRejectedValueOnce('socket died');

        // The original rejection value is rethrown as-is.
        await expect(pool.query('SELECT 1').catch((err) => err)).resolves.toBe('socket died');

        expect(pool.totalCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        await pool.end();
    });

    test('a failed query does not disturb the pool for the next caller', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        const querySpy = jest.spyOn(NzConnection.prototype, 'query');
        querySpy.mockRejectedValueOnce(sqlError());

        await expect(pool.query('SELECT * FROM NO_SUCH')).rejects.toThrow(/relation does not exist/);

        // The next call must reuse the surviving idle connection instead of
        // paying for a new handshake.
        connectSpy.mockClear();
        querySpy.mockResolvedValueOnce({ rows: [{ N: 1 }], rowCount: 1, fields: [], notices: [] });
        await expect(pool.query('SELECT 1 AS n')).resolves.toMatchObject({ rowCount: 1 });

        expect(connectSpy).not.toHaveBeenCalled();
        expect(pool.totalCount).toBe(1);
        expect(closeSpy).not.toHaveBeenCalled();

        await pool.end();
    });
});
