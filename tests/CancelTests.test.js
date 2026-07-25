
const { NzConnection } = require('../dist/cjs/NzConnection');

const { getNzConfig } = require('./helpers/env');
const config = (() => { try { return getNzConfig(); } catch (e) { return null; } })();
const describeNz = config ? describe : describe.skip;


const HEAVY_SQL = `
        SELECT     
        F1.PRODUCTKEY    
        , COUNT(DISTINCT (F1.PRODUCTKEY / F2.PRODUCTKEY))    
        FROM     
        ( SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY LIMIT 30000) F1,    
        ( SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY LIMIT 30000) F2    
        GROUP BY 1    
        LIMIT 500    
`;

const READER_HEAVY_SQL = `
        SELECT 2, F1.*
        FROM JUST_DATA..FACTPRODUCTINVENTORY F1
        JOIN JUST_DATA..DIMDATE D1 ON 1=1
        LIMIT 50000000
`;

const CANCEL_SLA_MS = 2000;

async function ensureTempTable(conn) {
    const dropCmd = conn.createCommand("DROP TABLE TT1 IF EXISTS");
    await dropCmd.executeNonQuery();

    const createCmd = conn.createCommand(`
        CREATE TEMP TABLE TT1 AS
        (
            SELECT 1 AS COLUMN_ONE
        )
        DISTRIBUTE ON RANDOM
    `);
    await createCmd.executeNonQuery();

    const verifyCmd = conn.createCommand("SELECT COLUMN_ONE FROM TT1");
    const verifyReader = await verifyCmd.executeReader();
    expect(await verifyReader.read()).toBe(true);
    expect(Number(verifyReader.getValue(0))).toBe(1);
    await verifyReader.close();
}

async function readRows(reader, expectedRows) {
    let rowsRead = 0;
    while (rowsRead < expectedRows) {
        const hasRow = await reader.read();
        if (!hasRow) {
            throw new Error(`Reader ended before ${expectedRows} rows. Got ${rowsRead}.`);
        }
        rowsRead++;
    }
    return rowsRead;
}

describeNz('NzDriver - Query Cancellation', () => {
    let conn;

    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();
        // Disable automatic timeout so we can test manual cancellation
        conn.commandTimeout = 0;
    });

    afterAll(async () => {
        if (conn) await conn.close();
    });

    test('Should cancel long running query multiple times and preserve session (Temp Tables)', async () => {
        // Create a temp table to verify session persistence
        const setupCmd = conn.createCommand("create temp table abc_cancel_test as (select 1 as col1)");
        await setupCmd.executeNonQuery();

        // Loop to verify stability over multiple cancellations
        for (let i = 0; i < 3; i++) {
            console.log(`Starting cancellation iteration ${i + 1}/3`);
            const cmd = conn.createCommand(HEAVY_SQL);

            const start = Date.now();

            // Schedule cancel to happen after 1 second
            // This will run DURING executeReader since the heavy query takes many seconds
            const cancelTimer = setTimeout(async () => {
                console.log(`Cancelling query at ${Date.now() - start}ms...`);
                try {
                    await cmd.cancel();
                    console.log('Cancel signal sent.');
                } catch (err) {
                    console.error("Cancel failed", err);
                }
            }, 1000);

            // Execute reader and read - should be interrupted by cancel
            try {
                const reader = await cmd.executeReader();
                clearTimeout(cancelTimer);

                while (await reader.read()) {
                    // Just consume
                }
                await reader.close();

                // If we get here, query completed before cancel - that's unexpected
                throw new Error("Query should have been cancelled but finished successfully");
            } catch (e) {
                clearTimeout(cancelTimer);
                console.log("Caught expected error:", e.message);
                expect(e.message).toMatch(/cancel|terminat|user requested cancel|rolled back/i);
            }

            const duration = Date.now() - start;
            console.log(`Iteration ${i + 1} completed in ${duration}ms`);

            // Should complete quickly (around 1-2 seconds), not the full query time
            expect(duration).toBeLessThan(10000);

            // Brief pause between iterations
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Verify session is still alive and temp table exists
        const verifyCmd = conn.createCommand("SELECT * FROM abc_cancel_test");
        const reader = await verifyCmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0).toString()).toBe('1');
        await reader.close();

        console.log('Cancellation test loop passed, session state preserved.');
    }, 60000);

    test('Should cancel active reader and execute next SQL within SLA', async () => {
        await ensureTempTable(conn);

        for (let i = 0; i < 3; i++) {
            const cmd = conn.createCommand(READER_HEAVY_SQL);
            const reader = await cmd.executeReader();

            const rowsRead = await readRows(reader, 1000);
            expect(rowsRead).toBe(1000);

            const start = Date.now();
            await cmd.cancel();
            await reader.close();

            cmd.commandText = "SELECT COLUMN_ONE FROM TT1";
            const verifyReader = await cmd.executeReader();
            const hasRow = await verifyReader.read();
            const value = hasRow ? Number(verifyReader.getValue(0)) : null;
            await verifyReader.close();

            const elapsed = Date.now() - start;
            console.log(`Cancel->next SQL latency (iteration ${i + 1}): ${elapsed}ms`);

            expect(hasRow).toBe(true);
            expect(value).toBe(1);
            expect(elapsed).toBeLessThan(CANCEL_SLA_MS);
        }
    }, 90000);

    test('Reader close after cancel should complete quickly and preserve session', async () => {
        await ensureTempTable(conn);

        const cmd = conn.createCommand(READER_HEAVY_SQL);
        const reader = await cmd.executeReader();
        await readRows(reader, 1000);

        await cmd.cancel();
        const closeStart = Date.now();
        await reader.close();
        const closeElapsed = Date.now() - closeStart;
        console.log(`reader.close() after cancel latency: ${closeElapsed}ms`);
        expect(closeElapsed).toBeLessThan(CANCEL_SLA_MS);

        cmd.commandText = "SELECT COLUMN_ONE FROM TT1";
        const verifyReader = await cmd.executeReader();
        expect(await verifyReader.read()).toBe(true);
        expect(Number(verifyReader.getValue(0))).toBe(1);
        await verifyReader.close();
    }, 60000);
});
