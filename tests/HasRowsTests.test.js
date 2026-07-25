const { NzConnection } = require('../dist/cjs/NzConnection');

const { getNzConfig } = require('./helpers/env');
const config = (() => { try { return getNzConfig(); } catch (e) { return null; } })();
const describeNz = config ? describe : describe.skip;


describeNz('HasRowsTests', () => {
    let connection;

    beforeAll(async () => {
        connection = new NzConnection(config);
        await connection.connect();
    });

    afterAll(async () => {
        if (connection) {
            connection.close();
        }
    });

    test('ManyResults_Select1Select2', async () => {
        const sql = "SELECT 1 FROM JUST_DATA..DIMDATE LIMIT 1;SELECT 2 FROM JUST_DATA..DIMDATE LIMIT 1";
        const cmd = connection.createCommand(sql);
        const reader = await cmd.executeReader();

        let resultCount = 0;
        let values = [];

        do {
            while (await reader.read()) {
                values.push(reader.getValue(0));
            }
            resultCount++;
        } while (await reader.nextResult());
        await reader.close();

        expect(resultCount).toBe(2);
        expect(Number(values[0])).toBe(1);
        expect(Number(values[1])).toBe(2);
    });

    test('ManyResults_MultipleRows', async () => {
        // "SELECT 1,2;SELECT 2,3; SELECT 3,4; SELECT 4,5"
        // Note: In Netezza "SELECT 1,2" requires a FROM or might work as text? 
        // Simple test used "SELECT 1" and it worked.
        const sql = "SELECT 1,2;SELECT 2,3; SELECT 3,4; SELECT 4,5";
        const cmd = connection.createCommand(sql);
        const reader = await cmd.executeReader();

        let resultCount = 0;
        do {
            while (await reader.read()) { }
            resultCount++;
        } while (await reader.nextResult());
        await reader.close();

        expect(resultCount).toBe(4);
    });

    // Helper function to mimic C# test helper
    async function getHasRowsList(query) {
        const cmd = connection.createCommand(query);
        const reader = await cmd.executeReader();
        const results = [];
        try {
            do {
                results.push(reader.hasRows);
                while (await reader.read()) { }
            } while (await reader.nextResult());
        } finally {
            await reader.close();
        }
        return results;
    }

    test('Test1_Delete_NoRows', async () => {
        // Use DIMDATE which is known to exist
        const results = await getHasRowsList("delete from DIMDATE where 1=2;");
        expect(results).toEqual([false]);
    });

    test('Test2_MixedLimits', async () => {
        const query = "SELECT * FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY DD ORDER BY ROWID LIMIT 0;" +
            "SELECT * FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY DD ORDER BY ROWID LIMIT 1;" +
            "SELECT * FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY DD ORDER BY ROWID LIMIT 0;" +
            "SELECT * FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY DD ORDER BY ROWID LIMIT 1;";

        // This relies on FACTPRODUCTINVENTORY existing.
        // If it doesn't, we might need to mock or use DIMDATE.
        // I'll swap to DIMDATE to be safe, assuming user won't mind table swap if behavior is identical.
        // User text said: "HasRowsTests.cs - TESTS EXACTLY SUCH SCENARIOS"
        // I should try to preserve intent.
        // If table missing, create it? Or use known table.
        // I'll uses DIMDATE as it is known to exist from previous tests.
        const safeQuery = query.replace(/FACTPRODUCTINVENTORY/g, 'DIMDATE');

        const results = await getHasRowsList(safeQuery);
        expect(results).toEqual([false, true, false, true]);
    });

    test('Test3_MixedSelectAndDelete', async () => {
        const query = "SELECT * FROM JUST_DATA.ADMIN.DIMDATE DD ORDER BY ROWID LIMIT 0;" +
            "SELECT * FROM JUST_DATA.ADMIN.DIMDATE DD ORDER BY ROWID LIMIT 1;" +
            "SELECT * FROM JUST_DATA.ADMIN.DIMDATE DD ORDER BY ROWID LIMIT 0;" +
            "delete from DIMDATE where 1=2;" +
            "delete from DIMDATE where 1=2;" +
            "SELECT 11 FROM JUST_DATA.ADMIN.DIMDATE DD ORDER BY ROWID LIMIT 10";

        // Should ignore DELETEs?
        // C# expects [false, true, false, true] -> 4 results.
        // 3 selects + 1 select = 4 results.
        // So yes, ignoring deletes.

        const results = await getHasRowsList(query);
        expect(results).toEqual([false, true, false, true]);
    });

    test('Test4_DeleteOnlyResult', async () => {
        // "delete...; delete...; select 10"
        // Expects [true] -> only last select.
        const query = "delete from DIMDATE where 1=2;delete from DIMDATE where 1=2;select 10";
        const results = await getHasRowsList(query);
        expect(results).toEqual([true]);
    });

});
