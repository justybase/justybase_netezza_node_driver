const { NzConnection } = require('../dist/cjs/NzConnection');

const { getNzConfig } = require('./helpers/env');
const config = (() => { try { return getNzConfig(); } catch (e) { return null; } })();
const describeNz = config ? describe : describe.skip;


const HEAVY_SQL = `
    SELECT F1.PRODUCTKEY, COUNT(DISTINCT (F1.PRODUCTKEY / F2.PRODUCTKEY))    
    FROM     
    ( SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY LIMIT 30000) F1,    
    ( SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY LIMIT 30000) F2    
    GROUP BY 1
    LIMIT 500    
`;

describeNz('NzDriver - Command Timeout', () => {
    let conn;

    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterAll(() => {
        conn.close();
    });

    test('Should timeout long running query', async () => {
        console.log('--- Timeout Test Start ---');
        // Set timeout to 4 second (since query takes more than 4 second)
        conn.commandTimeout = 4;

        const cmd = conn.createCommand(HEAVY_SQL);
        expect(cmd.commandTimeout).toBe(4);

        const start = Date.now();
        try {
            await cmd.executeReader();
            throw new Error("Query should have timed out");
        } catch (e) {
            const duration = Date.now() - start;
            console.log(`Caught error: ${e.message} after ${duration}ms`);

            // Check if error is timeout
            expect(e.message).toMatch(/Command execution timeout/i);

            // Expected duration around 4000ms
            expect(duration).toBeGreaterThan(3000);
            expect(duration).toBeLessThan(5000);
        }

        // Verify connection is still alive (wait for background query to finish draining)
        await new Promise(resolve => setTimeout(resolve, 5000));
        const simpleCmd = conn.createCommand('SELECT 1');
        const reader = await simpleCmd.executeReader();

        let rowCount = 0;
        while (await reader.read()) {
            rowCount++;
        }
        await reader.close();

        expect(rowCount).toBe(1);
    }, 20000); // 20s test timeout
});
