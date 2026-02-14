
const { NzConnection } = require('../dist/NzConnection');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

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

describe('NzDriver - Query Cancellation', () => {
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
});
