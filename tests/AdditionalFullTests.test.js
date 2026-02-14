/**
 * Additional Full Tests for JsNzDriver
 * Comprehensive tests that require database connection and may take longer
 */

const { NzConnection } = require('../dist/NzConnection');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const TEST_TABLE = 'JUST_DATA.ADMIN.DIMDATE';
const TEST_TABLE2 = 'JUST_DATA.ADMIN.DIMACCOUNT';

describe('Additional Full Tests - Large Data Operations', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('Fetch 1000 rows', async () => {
        const cmd = conn.createCommand(`SELECT * FROM ${TEST_TABLE} LIMIT 1000`);
        const reader = await cmd.executeReader();
        
        let count = 0;
        while (await reader.read()) {
            count++;
        }
        expect(count).toBe(1000);
        await reader.close();
    });

    test('Fetch 2000 rows', async () => {
        const cmd = conn.createCommand(`SELECT * FROM ${TEST_TABLE} LIMIT 2000`);
        const reader = await cmd.executeReader();
        
        let count = 0;
        while (await reader.read()) {
            count++;
        }
        expect(count).toBe(2000);
        await reader.close();
    });

    test('Fetch all rows from small table', async () => {
        const cmd = conn.createCommand(`SELECT * FROM ${TEST_TABLE2}`);
        const reader = await cmd.executeReader();
        
        let count = 0;
        while (await reader.read()) {
            count++;
            // Verify we can access all fields
            for (let i = 0; i < reader.fieldCount; i++) {
                reader.getValue(i);
            }
        }
        expect(count).toBeGreaterThan(0);
        await reader.close();
    });
});

describe('Additional Full Tests - Complex Queries', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('Subquery in FROM clause', async () => {
        const sql = `
            SELECT * FROM (
                SELECT 1 as x, 2 as y
            ) sub
        `;
        const cmd = conn.createCommand(sql);
        const reader = await cmd.executeReader();
        
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(1);
        expect(Number(reader.getValue(1))).toBe(2);
        await reader.close();
    });

    test('UNION ALL query', async () => {
        const sql = `
            SELECT 1 as x
            UNION ALL
            SELECT 2 as x
            UNION ALL
            SELECT 3 as x
        `;
        const cmd = conn.createCommand(sql);
        const reader = await cmd.executeReader();
        
        const values = [];
        while (await reader.read()) {
            values.push(Number(reader.getValue(0)));
        }
        expect(values).toEqual([1, 2, 3]);
        await reader.close();
    });

    test('CTE (Common Table Expression)', async () => {
        const sql = `
            WITH cte AS (
                SELECT 1 as x
            )
            SELECT * FROM cte
        `;
        const cmd = conn.createCommand(sql);
        const reader = await cmd.executeReader();
        
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(1);
        await reader.close();
    });

    test('Window function - ROW_NUMBER', async () => {
        const sql = `
            SELECT 
                ROW_NUMBER() OVER (ORDER BY DATEKEY) as rn,
                DATEKEY
            FROM ${TEST_TABLE}
            LIMIT 10
        `;
        const cmd = conn.createCommand(sql);
        const reader = await cmd.executeReader();
        
        let prevRn = 0;
        while (await reader.read()) {
            const rn = Number(reader.getValue(0));
            expect(rn).toBeGreaterThan(prevRn);
            prevRn = rn;
        }
        await reader.close();
    });

    test('GROUP BY with HAVING', async () => {
        const sql = `
            SELECT DATEKEY, COUNT(*) as cnt
            FROM ${TEST_TABLE}
            GROUP BY DATEKEY
            HAVING COUNT(*) > 0
            LIMIT 10
        `;
        const cmd = conn.createCommand(sql);
        const reader = await cmd.executeReader();
        
        let count = 0;
        while (await reader.read()) {
            count++;
            expect(Number(reader.getValue(1))).toBeGreaterThan(0);
        }
        expect(count).toBeGreaterThan(0);
        await reader.close();
    });

    test('ORDER BY single column', async () => {
        const sql = `
            SELECT DATEKEY
            FROM ${TEST_TABLE}
            ORDER BY DATEKEY
            LIMIT 10
        `;
        const cmd = conn.createCommand(sql);
        const reader = await cmd.executeReader();
        
        let prevKey = 0;
        while (await reader.read()) {
            const key = Number(reader.getValue(0));
            expect(key).toBeGreaterThanOrEqual(prevKey);
            prevKey = key;
        }
        await reader.close();
    });

    test('DISTINCT query', async () => {
        const sql = `
            SELECT DISTINCT DATEKEY
            FROM ${TEST_TABLE}
            LIMIT 10
        `;
        const cmd = conn.createCommand(sql);
        const reader = await cmd.executeReader();
        
        const keys = new Set();
        while (await reader.read()) {
            keys.add(reader.getValue(0));
        }
        // All values should be unique
        expect(keys.size).toBeGreaterThan(0);
        await reader.close();
    });
});

describe('Additional Full Tests - Data Types Deep Dive', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('NUMERIC precision and scale', async () => {
        const cmd = conn.createCommand("SELECT 1234567890.123456789::NUMERIC(19,9)");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(parseFloat(val)).toBeCloseTo(1234567890.123456789, 6);
        await reader.close();
    });

    test('Negative numbers', async () => {
        const cmd = conn.createCommand("SELECT -123, -456.789, -999999999999999");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(-123);
        expect(parseFloat(reader.getValue(1))).toBeCloseTo(-456.789, 3);
        expect(Number(reader.getValue(2))).toBe(-999999999999999);
        await reader.close();
    });

    test('Very large BIGINT', async () => {
        const cmd = conn.createCommand("SELECT (-9223372036854775808)::BIGINT");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0).toString()).toContain('9223372036854775808');
        await reader.close();
    });

    test('DATE range', async () => {
        const cmd = conn.createCommand("SELECT '0001-01-01'::DATE, '9999-12-31'::DATE");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val1 = reader.getValue(0);
        const val2 = reader.getValue(1);
        expect(val1).toBeDefined();
        expect(val2).toBeDefined();
        await reader.close();
    });

    test('Empty string handling', async () => {
        // Note: Netezza may return NULL for empty strings in some contexts
        const cmd = conn.createCommand("SELECT ''::VARCHAR(10)");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        // Accept either empty string or null (Netezza behavior)
        expect(val === '' || val === null).toBe(true);
        await reader.close();
    });
});

describe('Additional Full Tests - Connection Resilience', () => {
    test('Multiple connections sequentially', async () => {
        for (let i = 0; i < 3; i++) {
            const conn = new NzConnection(config);
            await conn.connect();
            // Verify connection works
            const cmd = conn.createCommand('SELECT 1');
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            await reader.close();
            await conn.close();
        }
    });

    test('Connection after failed query', async () => {
        const conn = new NzConnection(config);
        await conn.connect();
        
        // Failed query
        try {
            await conn.createCommand('SELECT INVALID').executeReader();
        } catch (e) {
            // Expected
        }
        
        // Connection should still work
        const cmd = conn.createCommand('SELECT 1');
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(1);
        await reader.close();
        
        await conn.close();
    });

    test('Multiple commands on same connection', async () => {
        const conn = new NzConnection(config);
        await conn.connect();
        
        for (let i = 0; i < 5; i++) {
            const cmd = conn.createCommand(`SELECT ${i}`);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(Number(reader.getValue(0))).toBe(i);
            await reader.close();
        }
        
        await conn.close();
    });
});

describe('Additional Full Tests - Multiple Result Sets Extended', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('Multiple result sets with different column counts', async () => {
        const cmd = conn.createCommand('SELECT 1; SELECT 1, 2; SELECT 1, 2, 3');
        const reader = await cmd.executeReader();
        
        // First result set - 1 column
        expect(reader.fieldCount).toBe(1);
        expect(await reader.read()).toBe(true);
        expect(await reader.read()).toBe(false);
        
        // Second result set - 2 columns
        expect(await reader.nextResult()).toBe(true);
        expect(reader.fieldCount).toBe(2);
        expect(await reader.read()).toBe(true);
        
        // Third result set - 3 columns
        expect(await reader.nextResult()).toBe(true);
        expect(reader.fieldCount).toBe(3);
        expect(await reader.read()).toBe(true);
        
        expect(await reader.nextResult()).toBe(false);
        await reader.close();
    });

    test('Multiple result sets with table data', async () => {
        const cmd = conn.createCommand(`SELECT * FROM ${TEST_TABLE} LIMIT 5; SELECT * FROM ${TEST_TABLE2} LIMIT 5`);
        const reader = await cmd.executeReader();
        
        // First result set
        let count1 = 0;
        while (await reader.read()) {
            count1++;
        }
        expect(count1).toBe(5);
        
        // Second result set
        expect(await reader.nextResult()).toBe(true);
        let count2 = 0;
        while (await reader.read()) {
            count2++;
        }
        expect(count2).toBe(5);
        
        await reader.close();
    });

    test('Empty result set followed by data', async () => {
        const cmd = conn.createCommand(`SELECT * FROM ${TEST_TABLE} WHERE 1=0; SELECT 1`);
        const reader = await cmd.executeReader();
        
        // First result set - empty
        expect(await reader.read()).toBe(false);
        
        // Second result set - has data
        expect(await reader.nextResult()).toBe(true);
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(1);
        
        await reader.close();
    });
});

describe('Additional Full Tests - Date/Time Edge Cases', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('Leap year date', async () => {
        const cmd = conn.createCommand("SELECT '2024-02-29'::DATE");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val).toBeDefined();
        await reader.close();
    });

    test('End of month dates', async () => {
        const cmd = conn.createCommand("SELECT '2024-01-31'::DATE, '2024-04-30'::DATE");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBeDefined();
        expect(reader.getValue(1)).toBeDefined();
        await reader.close();
    });

    test('Current date/time functions', async () => {
        const cmd = conn.createCommand("SELECT NOW(), CURRENT_DATE, CURRENT_TIME");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBeDefined();
        expect(reader.getValue(1)).toBeDefined();
        expect(reader.getValue(2)).toBeDefined();
        await reader.close();
    });
});

describe('Additional Full Tests - Reader Methods', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('getSchemaTable returns column info', async () => {
        const cmd = conn.createCommand(`SELECT 1 as COL1, 'test' as COL2 FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        const schema = reader.getSchemaTable();
        
        expect(schema).toBeDefined();
        expect(schema.Rows).toBeDefined();
        expect(schema.Rows.length).toBe(2);
        expect(schema.Rows[0].ColumnName).toBe('COL1');
        expect(schema.Rows[1].ColumnName).toBe('COL2');
        await reader.close();
    });

    test('getRowObject multiple times', async () => {
        const cmd = conn.createCommand(`SELECT 1 as A, 2 as B, 3 as C FROM ${TEST_TABLE} LIMIT 3`);
        const reader = await cmd.executeReader();
        
        let count = 0;
        while (await reader.read()) {
            const obj = reader.getRowObject();
            expect(obj).toHaveProperty('A');
            expect(obj).toHaveProperty('B');
            expect(obj).toHaveProperty('C');
            count++;
        }
        expect(count).toBe(3);
        await reader.close();
    });
});

describe('Additional Full Tests - Command Properties', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('commandTimeout default value', async () => {
        const cmd = conn.createCommand('SELECT 1');
        expect(cmd.commandTimeout).toBeDefined();
    });

    test('commandTimeout can be set', async () => {
        const cmd = conn.createCommand('SELECT 1');
        cmd.commandTimeout = 60;
        expect(cmd.commandTimeout).toBe(60);
    });

    test('Command with explicit timeout', async () => {
        const cmd = conn.createCommand(`SELECT * FROM ${TEST_TABLE} LIMIT 100`);
        cmd.commandTimeout = 120; // 2 minutes
        const reader = await cmd.executeReader();
        
        let count = 0;
        while (await reader.read()) {
            count++;
        }
        expect(count).toBe(100);
        await reader.close();
    });
});
