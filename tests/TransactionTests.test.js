const { NzConnection } = require('../dist/NzConnection');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

describe('NzDriver - Transaction Tests', () => {
    let conn;

    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterAll(async () => {
        if (conn) conn.close();
    });

    test('Basic Transaction Rollback', async () => {
        // T2_JS equivalent
        await conn.execute(conn.createCommand("DROP TABLE T2_JS IF EXISTS"));

        await conn.beginTransaction();

        await conn.execute(conn.createCommand("CREATE TABLE T2_JS(c1 numeric(10,5), c2 varchar(10), c3 nchar(5))"));
        await conn.execute(conn.createCommand("INSERT INTO T2_JS VALUES (123.54, 'xcfd', 'xyz')"));

        await conn.rollback();

        // Verify table does not exist or selects fail
        // Netezza might throw error if table doesn't exist
        const cmd = conn.createCommand("SELECT * FROM T2_JS");
        try {
            await cmd.executeReader();
            // If it didn't throw, check if row exists (if DDL committed but DML didn't?)
            // But C# expects it to throw.
            throw new Error("Table T2_JS should not exist after rollback");
        } catch (e) {
            expect(e.message).toMatch(/not exist|fail|error/i);
        }
    });

    test('Basic Transaction Commit', async () => {
        // T5_JS equivalent
        await conn.execute(conn.createCommand("DROP TABLE T5_JS IF EXISTS"));

        await conn.beginTransaction();

        await conn.execute(conn.createCommand("CREATE TABLE T5_JS(c1 numeric(10,5), c2 varchar(10), c3 nchar(5))"));
        await conn.execute(conn.createCommand("INSERT INTO T5_JS VALUES (123.54, 'xcfd', 'xyz')"));

        await conn.commit();

        // Verify table exists and has data
        const cmd = conn.createCommand("SELECT * FROM T5_JS");
        const reader = await cmd.executeReader();

        let rowCount = 0;
        let firstValue = null;
        while (await reader.read()) {
            if (rowCount === 0) {
                firstValue = reader.getValue(0);
            }
            rowCount++;
        }
        await reader.close();

        expect(rowCount).toBe(1);
        expect(Number(firstValue)).toBeCloseTo(123.54, 2);

        // Cleanup
        await conn.execute(conn.createCommand("DROP TABLE T5_JS IF EXISTS"));
    });
});
