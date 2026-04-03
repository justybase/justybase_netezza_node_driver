/**
 * Additional Smoke Tests for JsNzDriver
 * Fast tests covering more functionality without long-running operations
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

describe('Additional Smoke Tests - Expressions & Functions', () => {
    let conn;

    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterAll(async () => {
        if (conn) await conn.close();
    });

    describe('Arithmetic Expressions', () => {
        test.each([
            ['SELECT 1 + 1', 2],
            ['SELECT 10 - 3', 7],
            ['SELECT 4 * 5', 20],
            ['SELECT 20 / 4', 5],
            ['SELECT 17 % 5', 2],
        ])('Arithmetic: %s', async (query, expected) => {
            const cmd = conn.createCommand(query);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(Number(reader.getValue(0))).toBe(expected);
            await reader.close();
        });
    });

    describe('String Functions', () => {
        test.each([
            ["SELECT LENGTH('Hello')", 5],
            ["SELECT UPPER('hello')", 'HELLO'],
            ["SELECT LOWER('HELLO')", 'hello'],
            ["SELECT TRIM('  x  ')", 'x'],
            ["SELECT 'a' || 'b'", 'ab'], // Netezza uses || for concatenation
            ["SELECT SUBSTR('Hello', 1, 3)", 'Hel'],
        ])('String function: %s', async (query, expected) => {
            const cmd = conn.createCommand(query);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            const val = reader.getValue(0);
            expect(typeof expected === 'number' ? Number(val) : String(val).trim()).toBe(expected);
            await reader.close();
        });
    });

    describe('Conditional Expressions', () => {
        test('CASE WHEN simple', async () => {
            const cmd = conn.createCommand("SELECT CASE WHEN 1 = 1 THEN 'yes' ELSE 'no' END");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0).trim()).toBe('yes');
            await reader.close();
        });

        test('COALESCE with first non-null', async () => {
            const cmd = conn.createCommand("SELECT COALESCE(NULL, 'default')");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0).trim()).toBe('default');
            await reader.close();
        });

        test('COALESCE with first value', async () => {
            const cmd = conn.createCommand("SELECT COALESCE('first', 'second')");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0).trim()).toBe('first');
            await reader.close();
        });

        test('NULLIF returns null when equal', async () => {
            const cmd = conn.createCommand("SELECT NULLIF(1, 1)");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0)).toBeNull();
            await reader.close();
        });

        test('NULLIF returns value when not equal', async () => {
            const cmd = conn.createCommand("SELECT NULLIF(1, 2)");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(Number(reader.getValue(0))).toBe(1);
            await reader.close();
        });
    });

    describe('Boolean Operations', () => {
        test.each([
            ['SELECT true AND true', true],
            ['SELECT true AND false', false],
            ['SELECT false AND false', false],
            ['SELECT true OR false', true],
            ['SELECT false OR false', false],
            ['SELECT NOT true', false],
            ['SELECT NOT false', true],
        ])('Boolean: %s', async (query, expected) => {
            const cmd = conn.createCommand(query);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            const val = reader.getValue(0);
            expect(typeof val).toBe('boolean');
            expect(val).toBe(expected);
            await reader.close();
        });
    });

    describe('Comparison Operators', () => {
        test.each([
            ['SELECT 1 = 1', true],
            ['SELECT 1 = 2', false],
            ['SELECT 1 <> 2', true],
            ['SELECT 1 < 2', true],
            ['SELECT 2 > 1', true],
            ['SELECT 1 <= 1', true],
            ['SELECT 1 >= 1', true],
            ['SELECT 1 IS NULL', false],
            ['SELECT NULL IS NULL', true],
            ['SELECT 1 IS NOT NULL', true],
        ])('Comparison: %s', async (query, expected) => {
            const cmd = conn.createCommand(query);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            const val = reader.getValue(0);
            expect(typeof val).toBe('boolean');
            expect(val).toBe(expected);
            await reader.close();
        });
    });

    describe('Aggregate Functions (Fast)', () => {
        test('COUNT on small limit', async () => {
            const cmd = conn.createCommand(`SELECT COUNT(*) FROM ${TEST_TABLE} LIMIT 10`);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(Number(reader.getValue(0))).toBeGreaterThan(0);
            await reader.close();
        });

        test('MIN/MAX on small dataset', async () => {
            const cmd = conn.createCommand(`SELECT MIN(1), MAX(1) FROM ${TEST_TABLE} LIMIT 1`);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(Number(reader.getValue(0))).toBe(1);
            expect(Number(reader.getValue(1))).toBe(1);
            await reader.close();
        });
    });

    describe('Type Casting', () => {
        test.each([
            ["SELECT '123'::INT", 123, 'number'],
            ["SELECT '2024-01-01'::DATE", '2024-01-01', 'date'],
            ["SELECT 123::VARCHAR(10)", '123', 'string'],
        ])('Cast: %s', async (query, expected, expectedType) => {
            const cmd = conn.createCommand(query);
            const reader = await cmd.executeReader();
            try {
                expect(await reader.read()).toBe(true);
                const val = reader.getValue(0);

                if (expectedType === 'number') {
                    expect(Number(val)).toBe(expected);
                } else if (expectedType === 'date') {
                    expect(val).toBeInstanceOf(Date);
                    expect(val.toISOString().slice(0, 10)).toBe(expected);
                } else {
                    expect(String(val)).toBe(expected);
                }
            } finally {
                await reader.close();
            }
        });
    });
});

describe('Additional Smoke Tests - Connection & State', () => {
    let conn;

    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterAll(async () => {
        if (conn) await conn.close();
    });

    test('Connection is established', () => {
        expect(conn._connected).toBe(true);
    });

    test('can create multiple commands', () => {
        const cmd1 = conn.createCommand('SELECT 1');
        const cmd2 = conn.createCommand('SELECT 2');
        expect(cmd1).toBeDefined();
        expect(cmd2).toBeDefined();
        expect(cmd1).not.toBe(cmd2);
    });

    test('columnDescriptions after query', async () => {
        const cmd = conn.createCommand(`SELECT 1 as A, 2 as B FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(reader.columnDescriptions).toBeDefined();
        expect(reader.columnDescriptions.length).toBe(2);
        expect(reader.columnDescriptions[0].name).toBe('A');
        expect(reader.columnDescriptions[1].name).toBe('B');
        await reader.close();
    });

    test('fieldCount is correct', async () => {
        const cmd = conn.createCommand(`SELECT 1, 2, 3 FROM ${TEST_TABLE} LIMIT 1`);
        const reader = await cmd.executeReader();
        expect(reader.fieldCount).toBe(3);
        await reader.close();
    });

    test('Unicode metadata stays string-like on live appliance', async () => {
        const cmd = conn.createCommand(`
            SELECT
                'AA'::VARCHAR(32) AS VC,
                'AA'::NVARCHAR(32) AS NVC,
                'AA'::NCHAR(8) AS NC,
                'AA'::NATIONAL CHARACTER VARYING(32) AS NCV,
                CURRENT_DATE AS CD,
                CURRENT_TIMESTAMP AS CTS
            FROM JUST_DATA..DIMACCOUNT
            LIMIT 1
        `);
        const reader = await cmd.executeReader();
        const schema = reader.getSchemaTable();

        expect(reader.getProviderType(0)).toBe(1043);
        expect(reader.getProviderType(1)).toBe(2530);
        expect(reader.getProviderType(2)).toBe(2522);
        expect(reader.getProviderType(3)).toBe(2530);
        expect(reader.getProviderType(4)).toBe(1082);

        expect(reader.getTypeName(0)).toBe('VARCHAR');
        expect(reader.getTypeName(1)).toBe('NVARCHAR');
        expect(reader.getTypeName(2)).toBe('NCHAR');
        expect(reader.getTypeName(3)).toBe('NVARCHAR');
        expect(reader.getTypeName(4)).toBe('DATE');

        expect(reader.getColumnMetadata(1).declaredTypeName).toBe('NVARCHAR(32)');
        expect(reader.getColumnMetadata(2).declaredTypeName).toBe('NCHAR(8)');
        expect(schema.Rows[1].DataType).toBe(String);
        expect(schema.Rows[2].DataType).toBe(String);
        expect(schema.Rows[4].DataType).toBe(Date);

        expect(await reader.read()).toBe(true);
        expect(typeof reader.getValue(0)).toBe('string');
        expect(typeof reader.getValue(1)).toBe('string');
        expect(typeof reader.getValue(2)).toBe('string');
        expect(typeof reader.getValue(3)).toBe('string');
        expect(reader.getValue(4)).toBeInstanceOf(Date);
        expect(reader.getValue(5)).toBeInstanceOf(Date);

        await reader.close();
    });

    test('Special provider OIDs from live appliance are classified consistently', async () => {
        const byteIntReader = await conn.createCommand(`SELECT 1::BYTEINT AS B FROM ${TEST_TABLE} LIMIT 1`).executeReader();
        const byteIntSchema = byteIntReader.getSchemaTable();

        expect(byteIntReader.getProviderType(0)).toBe(2500);
        expect(byteIntReader.getTypeName(0)).toBe('BYTEINT');
        expect(byteIntReader.getDeclaredTypeName(0)).toBe('BYTEINT');
        expect(byteIntSchema.Rows[0].DataType).toBe(Number);
        expect(byteIntSchema.Rows[0].ColumnSize).toBe(1);

        await byteIntReader.close();

        const systemReader = await conn.createCommand(`
            SELECT OBJID, CREATEDATE, OBJCLASS
            FROM JUST_DATA.._V_TABLE
            ORDER BY TABLENAME
            LIMIT 1
        `).executeReader();
        const systemSchema = systemReader.getSchemaTable();

        expect(systemReader.getProviderType(0)).toBe(26);
        expect(systemReader.getTypeName(0)).toBe('OID');
        expect(systemSchema.Rows[0].DataType).toBe(Number);

        expect(systemReader.getProviderType(1)).toBe(702);
        expect(systemReader.getTypeName(1)).toBe('ABSTIME');
        expect(systemSchema.Rows[1].DataType).toBe(Date);

        expect(systemReader.getProviderType(2)).toBe(26);
        expect(systemReader.getTypeName(2)).toBe('OID');
        expect(systemSchema.Rows[2].DataType).toBe(Number);

        await systemReader.close();
    });
});

describe('Additional Smoke Tests - Multiple Result Sets', () => {
    let conn;

    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterAll(async () => {
        if (conn) await conn.close();
    });

    test('Two simple SELECTs', async () => {
        const cmd = conn.createCommand('SELECT 1; SELECT 2');
        const reader = await cmd.executeReader();
        
        // First result set
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(1);
        expect(await reader.read()).toBe(false);
        
        // Second result set
        expect(await reader.nextResult()).toBe(true);
        expect(await reader.read()).toBe(true);
        expect(Number(reader.getValue(0))).toBe(2);
        
        await reader.close();
    });

    test('Three simple SELECTs', async () => {
        const cmd = conn.createCommand('SELECT 1; SELECT 2; SELECT 3');
        const reader = await cmd.executeReader();
        
        for (let i = 1; i <= 3; i++) {
            expect(await reader.read()).toBe(true);
            expect(Number(reader.getValue(0))).toBe(i);
            expect(await reader.read()).toBe(false);
            if (i < 3) {
                expect(await reader.nextResult()).toBe(true);
            }
        }
        
        expect(await reader.nextResult()).toBe(false);
        await reader.close();
    });
});

describe('Additional Smoke Tests - Error Handling', () => {
    let conn;

    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterAll(async () => {
        if (conn) await conn.close();
    });

    test('Invalid SQL throws error', async () => {
        const cmd = conn.createCommand('SELECT INVALID_SYNTAX');
        await expect(cmd.executeReader()).rejects.toThrow();
    });

    test('Division by zero throws error', async () => {
        const cmd = conn.createCommand('SELECT 1/0');
        await expect(cmd.executeReader()).rejects.toThrow();
    });

    test('Invalid table throws error', async () => {
        const cmd = conn.createCommand('SELECT * FROM NONEXISTENT_TABLE_12345');
        await expect(cmd.executeReader()).rejects.toThrow();
    });

    test('Invalid cast throws error', async () => {
        const cmd = conn.createCommand("SELECT 'not_a_number'::INT");
        await expect(cmd.executeReader()).rejects.toThrow();
    });
});