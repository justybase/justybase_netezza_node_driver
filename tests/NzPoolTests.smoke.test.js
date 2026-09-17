const { NzPool } = require('../dist/cjs/NzPool');

const { getNzConfig } = require('./helpers/env');
const config = (() => {
    try {
        return getNzConfig({ max: 2, idleTimeoutMillis: 5000 });
    } catch (e) {
        return null;
    }
})();
const describeNz = config ? describe : describe.skip;


describeNz('NzPool Tests', () => {
    let pool;

    beforeEach(() => {
        pool = new NzPool(config);
    });

    afterEach(async () => {
        if (pool) {
            await pool.end();
        }
    });

    test('NzPool basics - executeNonQuery and query', async () => {
        // Test executeNonQuery
        const result = await pool.executeNonQuery('SELECT 1');
        expect(result.rowsAffected).toBeDefined();

        // Test query — returns buffered QueryResult and auto-releases
        const queryResult = await pool.query('SELECT 12345 AS val');
        expect(queryResult.rowCount).toBe(1);
        const row = queryResult.rows[0];
        expect(row.val ?? row.VAL).toBe(12345);

        expect(pool.totalCount).toBe(1);
        expect(pool.idleCount).toBe(1);
    }, 30000);

    test('NzPool max connections and queueing', async () => {
        // Max is 2
        const p1 = pool.connect();
        const p2 = pool.connect();

        const { client: c1, release: r1 } = await p1;
        const { client: c2, release: r2 } = await p2;

        expect(pool.totalCount).toBe(2);
        expect(pool.idleCount).toBe(0);

        // Third connect should block until one is released
        let p3Resolved = false;
        const p3 = pool.connect().then((res) => {
            p3Resolved = true;
            return res;
        });

        // Sleep briefly to ensure p3 doesn't resolve yet
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(p3Resolved).toBe(false);
        expect(pool.waitingCount).toBe(1);

        // Release c1
        r1();

        // Now p3 should resolve
        const { client: c3, release: r3 } = await p3;
        expect(p3Resolved).toBe(true);
        expect(pool.totalCount).toBe(2);
        expect(pool.idleCount).toBe(0);

        r2();
        r3();

        expect(pool.idleCount).toBe(2);
    }, 30000);

    test('keeps a healthy session after a SQL error instead of reconnecting', async () => {
        const removed = [];
        pool.on('remove', (client) => removed.push(client));

        const { client, release } = await pool.connect();
        await client.execute('CREATE TEMP TABLE POOL_KEEP_ALIVE (X INT)');
        await client.execute('INSERT INTO POOL_KEEP_ALIVE VALUES (1)');
        release();

        await expect(pool.query('SELECT * FROM NO_SUCH_TABLE_XYZ')).rejects.toThrow(/relation does not exist/i);

        // A clean SQL failure must not tear the connection down.
        expect(pool.totalCount).toBe(1);
        expect(pool.idleCount).toBe(1);
        expect(removed).toHaveLength(0);

        // TEMP tables are session-scoped, so finding the row proves the same
        // backend session was reused rather than reconnected.
        const result = await pool.query('SELECT X FROM POOL_KEEP_ALIVE');
        expect(result.rowCount).toBe(1);
        expect(Number(result.rows[0].X ?? result.rows[0].x)).toBe(1);
    }, 30000);

    test('rolls back an open transaction before the next checkout', async () => {
        // max: 1 forces the next checkout to wait for the recycling connection
        // instead of growing the pool with a fresh session.
        const single = new NzPool({ ...config, max: 1 });
        try {
            const first = await single.connect();
            await first.client.execute('CREATE TEMP TABLE POOL_TX_PROBE (X INT)');
            expect(first.client.inTransaction).toBe(false);

            await first.client.execute('BEGIN');
            expect(first.client.inTransaction).toBe(true);
            await first.client.execute('INSERT INTO POOL_TX_PROBE VALUES (1)');
            expect(await countRows(first.client, 'POOL_TX_PROBE')).toBe(1);
            first.release();

            // Not reusable until the rollback has run.
            expect(single.idleCount).toBe(0);

            const second = await single.connect();
            // Same session, but the transaction must have been closed.
            expect(second.client).toBe(first.client);
            expect(second.client.inTransaction).toBe(false);
            expect(await countRows(second.client, 'POOL_TX_PROBE')).toBe(0);
            second.release();
        } finally {
            await single.end();
        }
    }, 30000);

    test('tracks transaction state for statements issued directly', async () => {
        const { client, release } = await pool.connect();

        await client.execute('BEGIN');
        expect(client.inTransaction).toBe(true);
        await client.execute('COMMIT');
        expect(client.inTransaction).toBe(false);

        await client.execute('BEGIN');
        await client.query('SELECT 1 AS n');
        expect(client.inTransaction).toBe(true);
        await client.rollback();
        expect(client.inTransaction).toBe(false);

        release();
    }, 30000);
});

/** COUNT(*) comes back as a BIGINT, so it is normalized for comparisons. */
async function countRows(client, table) {
    const result = await client.query(`SELECT COUNT(*) AS N FROM ${table}`);
    const row = result.rows[0];
    return Number(row.N ?? row.n);
}
