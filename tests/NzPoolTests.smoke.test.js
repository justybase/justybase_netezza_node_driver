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
});
