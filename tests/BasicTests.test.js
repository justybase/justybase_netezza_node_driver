/**
 * Comprehensive tests for JsNzDriver
 * Each test has variants: "loose" queries (SELECT X) and table queries (SELECT X FROM table)
 * This ensures both text-based (DataRow) and binary (RowStandard) formats are tested.
 */

const { NzConnection } = require('../dist/cjs/NzConnection');

const { getNzConfig } = require('./helpers/env');
const config = (() => { try { return getNzConfig(); } catch (e) { return null; } })();
const describeNz = config ? describe : describe.skip;

// Configuration

// Test table that is guaranteed to exist
const TEST_TABLE = 'JUST_DATA.ADMIN.DIMDATE';

describeNz('NzDriver - Connection Tests', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('Connection Open', () => {
        expect(conn._connected).toBe(true);
    });
});

describeNz('NzDriver - Integer Types', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('SELECT integer (loose)', async () => {
        const cmd = conn.createCommand("SELECT 1");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val.toString()).toBe('1');
    });

    test('SELECT integer (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 1 FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(Number(val)).toBe(1);
    });

    test('SELECT byteint (loose)', async () => {
        const cmd = conn.createCommand("SELECT 15::BYTEINT");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(15);
    });

    test('SELECT byteint (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 15::BYTEINT FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(15);
    });

    test('SELECT smallint (loose)', async () => {
        const cmd = conn.createCommand("SELECT 1234::SMALLINT");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(1234);
    });

    test('SELECT smallint (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 1234::SMALLINT FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(1234);
    });

    test('SELECT bigint (loose)', async () => {
        const cmd = conn.createCommand("SELECT 9223372036854775807::BIGINT");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val.toString()).toContain('9223372036854775807');
    });

    test('SELECT bigint (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 9223372036854775807::BIGINT FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(BigInt(val.toString())).toBe(9223372036854775807n);
    });
});

describeNz('NzDriver - Float Types', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('SELECT float (loose)', async () => {
        const cmd = conn.createCommand("SELECT 3.14::FLOAT");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(parseFloat(reader.getValue(0))).toBeCloseTo(3.14, 2);
    });

    test('SELECT float (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 3.14::FLOAT FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(parseFloat(reader.getValue(0))).toBeCloseTo(3.14, 2);
    });

    test('SELECT double (loose)', async () => {
        const cmd = conn.createCommand("SELECT 3.14159265358979::DOUBLE PRECISION");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(parseFloat(reader.getValue(0))).toBeCloseTo(3.14159265358979, 10);
    });

    test('SELECT double (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 3.14159265358979::DOUBLE PRECISION FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(parseFloat(reader.getValue(0))).toBeCloseTo(3.14159265358979, 10);
    });
});

describeNz('NzDriver - Numeric/Decimal Types', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('SELECT numeric (loose)', async () => {
        const cmd = conn.createCommand("SELECT 12345.6789::NUMERIC(10,4)");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(parseFloat(reader.getValue(0))).toBeCloseTo(12345.6789, 4);
    });

    test('SELECT numeric (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 12345.6789::NUMERIC(10,4) FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(parseFloat(reader.getValue(0))).toBeCloseTo(12345.6789, 4);
    });

    test('SELECT high precision numeric (loose)', async () => {
        const cmd = conn.createCommand("SELECT 12345678901234567890.1234567890::NUMERIC(38,10)");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0).toString();
        expect(val).toContain('12345678901234567890');
    });

    test('SELECT high precision numeric (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 12345678901234567890.1234567890::NUMERIC(38,10) FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0).toString();
        expect(val).toContain('12345678901234567890');
    });
});

describeNz('NzDriver - String Types', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('SELECT varchar (loose)', async () => {
        const cmd = conn.createCommand("SELECT 'Hello World'::VARCHAR(100)");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0).toString()).toBe('Hello World');
    });

    test('SELECT varchar (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 'Hello World'::VARCHAR(100) FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0).toString()).toBe('Hello World');
    });

    test('SELECT char (loose)', async () => {
        const cmd = conn.createCommand("SELECT 'ABC'::CHAR(10)");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0).toString().trim()).toBe('ABC');
    });

    test('SELECT char (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 'ABC'::CHAR(10) FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0).toString().trim()).toBe('ABC');
    });

    test('SELECT nvarchar (loose)', async () => {
        const cmd = conn.createCommand("SELECT 'Zażółć gęślą jaźń'::NVARCHAR(100)");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0).toString()).toContain('Zażółć');
    });

    test('SELECT nvarchar (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 'Zażółć gęślą jaźń'::NVARCHAR(100) FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0).toString()).toContain('Zażółć');
    });
});

describeNz('NzDriver - Boolean Type', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('SELECT boolean true (loose)', async () => {
        const cmd = conn.createCommand("SELECT true::BOOLEAN");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val).toBe(true);
    });

    test('SELECT boolean true (from table)', async () => {
        const cmd = conn.createCommand(`SELECT true::BOOLEAN FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(true);
    });

    test('SELECT boolean false (loose)', async () => {
        const cmd = conn.createCommand("SELECT false::BOOLEAN");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val).toBe(false);
    });

    test('SELECT boolean false (from table)', async () => {
        const cmd = conn.createCommand(`SELECT false::BOOLEAN FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(false);
    });
});

describeNz('NzDriver - Date/Time Types', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('SELECT date (loose)', async () => {
        const cmd = conn.createCommand("SELECT '2024-12-11'::DATE");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2024-12-11T00:00:00.000Z');
    });

    test('SELECT date (from table)', async () => {
        const cmd = conn.createCommand(`SELECT '2024-12-11'::DATE FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2024-12-11T00:00:00.000Z');
    });

    test('SELECT time (loose)', async () => {
        const cmd = conn.createCommand("SELECT '12:30:45'::TIME");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val.toString()).toContain('12');
        expect(val.toString()).toContain('30');
    });

    test('SELECT time (from table)', async () => {
        const cmd = conn.createCommand(`SELECT '12:30:45'::TIME FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        if (typeof val === 'object' && val.hours !== undefined) {
            expect(val.hours).toBe(12);
            expect(val.minutes).toBe(30);
            expect(val.seconds).toBe(45);
        } else {
            expect(val.toString()).toContain('12');
        }
    });

    test('SELECT timestamp (loose)', async () => {
        const cmd = conn.createCommand("SELECT '2024-12-11 14:30:00'::TIMESTAMP");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2024-12-11T14:30:00.000Z');
    });

    test('SELECT timestamp (from table)', async () => {

    
        const cmd = conn.createCommand(`SELECT '2024-12-11 14:30:00'::TIMESTAMP FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        // Expected type is Date with UTC time '2024-12-11T14:30:00.000Z'
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2024-12-11T14:30:00.000Z');

    });

    // Additional timestamp tests with various date/time combinations
    test('SELECT timestamp 2023-03-26 01:30:00 (loose)', async () => {
        const cmd = conn.createCommand("SELECT '2023-03-26 01:30:00'::TIMESTAMP");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2023-03-26T01:30:00.000Z');
    });

    test('SELECT timestamp 2023-03-26 01:30:00 (from table)', async () => {
        const cmd = conn.createCommand(`SELECT '2023-03-26 01:30:00'::TIMESTAMP FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        // Binary format returns Date object
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2023-03-26T01:30:00.000Z');
    });

    test('SELECT timestamp 2023-03-31 12:30:00 (loose)', async () => {
        const cmd = conn.createCommand("SELECT '2023-03-31 12:30:00'::TIMESTAMP");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2023-03-31T12:30:00.000Z');
    });

    test('SELECT timestamp 2023-03-31 12:30:00 (from table)', async () => {
        const cmd = conn.createCommand(`SELECT '2023-03-31 12:30:00'::TIMESTAMP FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        // Binary format returns Date object
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2023-03-31T12:30:00.000Z');
    });

    test('SELECT timestamp 2023-03-01 12:30:00 (loose)', async () => {
        const cmd = conn.createCommand("SELECT '2023-03-01 12:30:00'::TIMESTAMP");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2023-03-01T12:30:00.000Z');
    });

    test('SELECT timestamp 2023-03-01 12:30:00 (from table)', async () => {
        const cmd = conn.createCommand(`SELECT '2023-03-01 12:30:00'::TIMESTAMP FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        // Binary format returns Date object
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2023-03-01T12:30:00.000Z');
    });

    test('SELECT date 2023-03-01 (loose)', async () => {
        const cmd = conn.createCommand("SELECT '2023-03-01'::DATE");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2023-03-01T00:00:00.000Z');
    });

    test('SELECT date 2023-03-01 (from table)', async () => {
        const cmd = conn.createCommand(`SELECT '2023-03-01'::DATE FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        // Binary format returns Date object
        expect(val instanceof Date).toBe(true);
        expect(val.toISOString()).toBe('2023-03-01T00:00:00.000Z');
    });

    test('SELECT interval (loose)', async () => {
        const cmd = conn.createCommand("SELECT '5 hours 30 minutes'::INTERVAL");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val.toString()).toContain('5');
    });

    test('SELECT interval (from table)', async () => {
        const cmd = conn.createCommand(`SELECT '5 hours 30 minutes'::INTERVAL FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        expect(val.toString()).toContain('5');
    });
});

describeNz('NzDriver - NULL Handling', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('SELECT NULL (loose)', async () => {
        const cmd = conn.createCommand("SELECT NULL");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBeNull();
    });

    test('SELECT NULL (from table)', async () => {
        const cmd = conn.createCommand(`SELECT NULL FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBeNull();
    });

    test('SELECT NULL::INTEGER (loose)', async () => {
        const cmd = conn.createCommand("SELECT NULL::INTEGER");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBeNull();
    });

    test('SELECT NULL::INTEGER (from table)', async () => {
        const cmd = conn.createCommand(`SELECT NULL::INTEGER FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBeNull();
    });
});

describeNz('NzDriver - Multiple Columns', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('SELECT multiple columns (loose)', async () => {
        const cmd = conn.createCommand("SELECT 1 as col1, 'text' as col2, 3.14 as col3");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.fieldCount).toBe(3);
    });

    test('SELECT multiple columns (from table)', async () => {
        const cmd = conn.createCommand(`SELECT 1 as col1, 'text' as col2, 3.14 as col3 FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.fieldCount).toBe(3);
    });
});

describeNz('NzDriver - Version Check', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('SELECT version()', async () => {
        const cmd = conn.createCommand("SELECT version()");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        const val = reader.getValue(0);
        console.log("Version:", val.toString());
        expect(val.toString()).toContain("Release");
    });
});

describeNz('NzDriver - NzDataReader API', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('Reader iteration', async () => {
        const cmd = conn.createCommand(`SELECT 1 as num, 'abc' as txt FROM ${TEST_TABLE} LIMIT 3`);
        const reader = await cmd.executeReader();

        let count = 0;
        while (await reader.read()) {
            expect(reader.fieldCount).toBe(2);
            expect(reader.getName(0)).toBe('NUM');
            expect(reader.getName(1)).toBe('TXT');
            count++;
        }
        expect(count).toBe(3);
    });

    test('Reader typed getters', async () => {
        const cmd = conn.createCommand(`SELECT 42 as int_col, 3.14 as float_col, 'hello' as str_col FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();

        expect(await reader.read()).toBe(true);
        expect(reader.getInt32(0)).toBe(42);
        expect(reader.getDouble(1)).toBeCloseTo(3.14, 2);
        expect(reader.getString(2)).toBe('hello');
    });

    test('Reader getRowObject', async () => {
        const cmd = conn.createCommand(`SELECT 1 as A, 2 as B FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();

        expect(await reader.read()).toBe(true);
        const obj = reader.getRowObject();
        expect(obj).toHaveProperty('A');
        expect(obj).toHaveProperty('B');
    });

    test('Reader iterator (for...of)', async () => {
        const cmd = conn.createCommand(`SELECT 1 as val FROM ${TEST_TABLE} LIMIT 2`);
        const reader = await cmd.executeReader();

        const rows = [];
        for await (const row of reader) {
            rows.push(row);
        }
        expect(rows.length).toBe(2);
    });
});

describeNz('NzDriver - Mixed Null Values C# Port', () => {
    let conn;

    beforeEach(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterEach(async () => {
        if (conn) await conn.close();
    });

    test('GetString_OnMixedNullAndNonNullValues_HandlesCorrectly', async () => {
        const cmd = conn.createCommand(`
            SELECT 
                NULL::VARCHAR(10) as c1,
                'abc' as c2,
                NULL::NVARCHAR(10) as c3,
                'def' as c4,
                NULL::NCHAR(10) as c5
        `);
        const reader = await cmd.executeReader();

        expect(await reader.read()).toBe(true);

        expect(reader.isDBNull(0)).toBe(true);
        expect(reader.isDBNull(2)).toBe(true);
        expect(reader.isDBNull(4)).toBe(true);

        expect(reader.getValue(0)).toBeNull();
        expect(reader.getValue(2)).toBeNull();
        expect(reader.getValue(4)).toBeNull();

        expect(reader.isDBNull(1)).toBe(false);
        expect(reader.isDBNull(3)).toBe(false);
        expect(reader.getString(1)).toBe("abc");
        expect(reader.getString(3)).toBe("def");
    });
});
