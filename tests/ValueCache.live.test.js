'use strict';

const { NzConnection } = require('../dist/cjs/NzConnection');
const { getNzConfig } = require('./helpers/env');

const config = (() => {
    try {
        return getNzConfig();
    } catch {
        return null;
    }
})();
const describeNz = config ? describe : describe.skip;
const run = process.env.NZ_RUN_VALUE_CACHE_LIVE === '1';

const QUERIES = [
    {
        name: 'PERF.EVENTS_400K projection',
        sql: `SELECT
    T1.EVENT_ID
    , T1.CUSTOMER_ID
    , T1.EVENT_TS
    , T1.AMOUNT
    , T1.TAX
    , T1.QUANTITY
    , T1.STATUS
    , T1.SKU
    , T1.NOTE
FROM JUST_DATA.PERF.EVENTS_400K T1;`,
    },
    {
        name: 'FACTPRODUCTINVENTORY projection',
        sql: `SELECT
    T1.PRODUCTKEY
    , T1.DATEKEY
    , T1.MOVEMENTDATE
    , T1.UNITCOST
    , T1.UNITSIN
    , T1.UNITSOUT
    , T1.UNITSBALANCE
FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY T1;`,
    },
];

describeNz('live value cache', () => {
    test.each(QUERIES)('$name deduplicates repeated values', async ({ sql }) => {
        if (!run) {
            console.warn('skipping live value-cache check: set NZ_RUN_VALUE_CACHE_LIVE=1');
            return;
        }
        const connection = new NzConnection(config);
        await connection.connect();
        try {
            const reader = await connection.createCommand(sql).executeReader();
            let rows = 0;
            while (await reader.read()) {
                // Touch every value so lazy/typed access goes through the cache.
                for (let i = 0; i < reader.fieldCount; i++) reader.getValue(i);
                rows++;
            }
            await reader.close();
            expect(rows).toBeGreaterThan(0);
            expect(connection.diagnostics.valueCacheHits).toBeGreaterThan(0);
            expect(connection.diagnostics.valueCacheInsertions).toBeGreaterThan(0);
        } finally {
            await connection.close();
        }
    });
});
