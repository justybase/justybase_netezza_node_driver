const { NzPool } = require('../dist/cjs/NzPool');
const { NzConnection } = require('../dist/cjs/NzConnection');

const baseConfig = {
    host: 'localhost',
    database: 'db',
    user: 'user',
    password: 'password',
};

describe('NzPool lifecycle', () => {
    let connectSpy;
    let closeSpy;

    beforeEach(() => {
        connectSpy = jest.spyOn(NzConnection.prototype, 'connect').mockResolvedValue(undefined);
        closeSpy = jest.spyOn(NzConnection.prototype, 'close').mockResolvedValue(undefined);
    });

    afterEach(() => {
        connectSpy.mockRestore();
        closeSpy.mockRestore();
    });

    test('rejects invalid pool limits before creating clients', () => {
        expect(() => new NzPool({ ...baseConfig, max: 0 })).toThrow(RangeError);
        expect(() => new NzPool({ ...baseConfig, min: 2, max: 1 })).toThrow(RangeError);
        expect(() => new NzPool({ ...baseConfig, connectionTimeoutMillis: -1 })).toThrow(RangeError);
    });

    test('rejects queued connect requests when the pool ends', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        const first = await pool.connect();
        const queued = pool.connect();

        const ending = pool.end();
        await expect(queued).rejects.toThrow('Cannot use a pool after calling end on the pool');

        first.release();
        await ending;
        expect(pool.totalCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    test('removes a client released with an error and rejects a second release', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        const { release } = await pool.connect();
        const error = new Error('command failed');

        release(error);
        expect(pool.totalCount).toBe(0);
        expect(pool.idleCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(() => release()).toThrow('already been released');

        await pool.end();
    });

    test('does not reinsert a client removed by a socket error when it is released later', async () => {
        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        const { client, release } = await pool.connect();

        client.emit('error', new Error('socket failed'));
        expect(pool.totalCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        release();
        expect(pool.totalCount).toBe(0);
        expect(pool.idleCount).toBe(0);

        await pool.end();
    });

    test('times out a queued request without leaving it in the queue', async () => {
        const pool = new NzPool({
            ...baseConfig,
            max: 1,
            idleTimeoutMillis: 0,
            connectionTimeoutMillis: 20,
        });
        const first = await pool.connect();
        const queued = pool.connect();

        await expect(queued).rejects.toThrow('Timeout exceeded when trying to connect');
        expect(pool.waitingCount).toBe(0);

        first.release();
        await pool.end();
    });

    test('ends a connection that is still establishing and rejects its checkout', async () => {
        let resolveConnect;
        connectSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveConnect = resolve;
                })
        );

        const pool = new NzPool({ ...baseConfig, max: 1, idleTimeoutMillis: 0 });
        const pending = pool.connect();
        const ending = pool.end();

        await expect(pending).rejects.toThrow('Cannot use a pool after calling end on the pool');
        await ending;
        expect(pool.totalCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        // A late successful handshake must not resurrect the removed client.
        resolveConnect();
        await new Promise((resolve) => setImmediate(resolve));
        expect(pool.totalCount).toBe(0);
    });

    test('removes a connection whose handshake exceeds connectionTimeoutMillis', async () => {
        let resolveConnect;
        connectSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveConnect = resolve;
                })
        );

        const pool = new NzPool({
            ...baseConfig,
            max: 1,
            idleTimeoutMillis: 0,
            connectionTimeoutMillis: 20,
        });
        const pending = pool.connect();

        await expect(pending).rejects.toThrow('Connection terminated due to connection timeout');
        expect(pool.totalCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        resolveConnect();
        await pool.end();
    });

    test('wakes queued requests after a warmup connection fails', async () => {
        const warmupError = new Error('warmup failed');
        connectSpy.mockRejectedValueOnce(warmupError);
        const pool = new NzPool({ ...baseConfig, min: 1, max: 1, idleTimeoutMillis: 0 });
        pool.on('error', () => {});

        await new Promise((resolve) => setImmediate(resolve));
        const checkout = await pool.connect();

        expect(checkout.client).toBeInstanceOf(NzConnection);
        expect(pool.totalCount).toBe(1);
        checkout.release();
        await pool.end();
    });
});
