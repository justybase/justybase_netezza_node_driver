/**
 * Smoke Tests for JsNzDriver
 * Fast subset of tests covering essential functionality
 * Uses single connection for all tests (beforeAll/afterAll)
 */

const { NzConnection } = require('../dist/cjs/NzConnection');

const { getNzConfig } = require('./helpers/env');
const config = (() => { try { return getNzConfig(); } catch (e) { return null; } })();
const describeNz = config ? describe : describe.skip;


const TEST_TABLE = 'JUST_DATA.ADMIN.DIMDATE';

describeNz('Smoke Tests - Core Functionality', () => {
    let conn;

    // Single connection for all tests - major speed improvement
    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();
    });

    afterAll(async () => {
        if (conn) await conn.close();
    });

    test('Connection established', () => {
        expect(conn._connected).toBe(true);
    });

    describe('Integer Types', () => {
        test.each([
            ['SELECT 1', 1],
            ['SELECT 15::BYTEINT', 15],
            ['SELECT 1234::SMALLINT', 1234],
            [`SELECT 1 FROM ${TEST_TABLE} LIMIT 1`, 1],
            [`SELECT 15::BYTEINT FROM ${TEST_TABLE} LIMIT 1`, 15],
            [`SELECT 1234::SMALLINT FROM ${TEST_TABLE} LIMIT 1`, 1234],
        ])('Query: %s', async (query, expected) => {
            const cmd = conn.createCommand(query);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(Number(reader.getValue(0))).toBe(expected);
            await reader.close();
        });

        test('BigInt handling', async () => {
            const cmd = conn.createCommand("SELECT 9223372036854775807::BIGINT");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0).toString()).toContain('9223372036854775807');
            await reader.close();
        });
    });

    describe('Float Types', () => {
        test.each([
            ['SELECT 3.14::FLOAT', 3.14, 2],
            ['SELECT 3.14159265358979::DOUBLE PRECISION', 3.14159265358979, 10],
            [`SELECT 3.14::FLOAT FROM ${TEST_TABLE} LIMIT 1`, 3.14, 2],
        ])('Query: %s', async (query, expected, precision) => {
            const cmd = conn.createCommand(query);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(parseFloat(reader.getValue(0))).toBeCloseTo(expected, precision);
            await reader.close();
        });
    });

    describe('String Types', () => {
        test.each([
            ["SELECT 'Hello World'::VARCHAR(100)", 'Hello World'],
            ["SELECT 'ABC'::CHAR(10)", 'ABC'],
            ["SELECT 'Zażółć'::NVARCHAR(100)", 'Zażółć'],
            [`SELECT 'Hello World'::VARCHAR(100) FROM ${TEST_TABLE} LIMIT 1`, 'Hello World'],
        ])('Query: %s', async (query, expected) => {
            const cmd = conn.createCommand(query);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            const value = reader.getValue(0).toString();
            expect(value.trim()).toBe(expected);
            await reader.close();
        });
    });

    describe('Date/Time Types', () => {
        test('Date handling', async () => {
            const cmd = conn.createCommand("SELECT '2024-12-11'::DATE");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            const val = reader.getValue(0);
            expect(val).toBeInstanceOf(Date);
            expect(val.toISOString()).toBe('2024-12-11T00:00:00.000Z');
            await reader.close();
        });

        test('Timestamp handling', async () => {
            const cmd = conn.createCommand(`SELECT '2024-12-11 14:30:00'::TIMESTAMP FROM ${TEST_TABLE} LIMIT 1`);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            const val = reader.getValue(0);
            expect(val instanceof Date).toBe(true);
            await reader.close();
        });
    });

    describe('NULL Handling', () => {
        test.each([
            'SELECT NULL',
            `SELECT NULL FROM ${TEST_TABLE} LIMIT 1`,
            'SELECT NULL::INTEGER',
        ])('NULL query: %s', async (query) => {
            const cmd = conn.createCommand(query);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0)).toBeNull();
            await reader.close();
        });
    });

    describe('Reader API', () => {
        test('Reader iteration', async () => {
            const cmd = conn.createCommand(`SELECT 1 as num, 'abc' as txt FROM ${TEST_TABLE} LIMIT 3`);
            const reader = await cmd.executeReader();
            
            let count = 0;
            while (await reader.read()) {
                expect(reader.fieldCount).toBe(2);
                count++;
            }
            expect(count).toBe(3);
            await reader.close();
        });

        test('getRowObject', async () => {
            const cmd = conn.createCommand(`SELECT 1 as A, 2 as B FROM ${TEST_TABLE} LIMIT 1`);
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            const obj = reader.getRowObject();
            expect(obj).toHaveProperty('A');
            expect(obj).toHaveProperty('B');
            await reader.close();
        });
    });

    test('Version query', async () => {
        const cmd = conn.createCommand("SELECT version()");
        const reader = await cmd.executeReader();
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0).toString()).toContain("Release");
        await reader.close();
    });

    // Additional tests for more coverage
    describe('Arithmetic Operations', () => {
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

    describe('Conditional Expressions', () => {
        test('CASE WHEN simple', async () => {
            const cmd = conn.createCommand("SELECT CASE WHEN 1 = 1 THEN 'yes' ELSE 'no' END");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0).trim()).toBe('yes');
            await reader.close();
        });

        test('COALESCE returns first non-null', async () => {
            const cmd = conn.createCommand("SELECT COALESCE(NULL, 'default')");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0).trim()).toBe('default');
            await reader.close();
        });

        test('NULLIF returns null when equal', async () => {
            const cmd = conn.createCommand("SELECT NULLIF(1, 1)");
            const reader = await cmd.executeReader();
            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0)).toBeNull();
            await reader.close();
        });
    });

    describe('Boolean Operations', () => {
        test.each([
            ['SELECT true AND true', true],
            ['SELECT true OR false', true],
            ['SELECT NOT true', false],
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
            ['SELECT 1 <> 2', true],
            ['SELECT 1 < 2', true],
            ['SELECT 1 IS NULL', false],
            ['SELECT NULL IS NULL', true],
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

    describe('Multiple Result Sets', () => {
        test('Two simple SELECTs', async () => {
            const cmd = conn.createCommand('SELECT 1; SELECT 2');
            const reader = await cmd.executeReader();
            
            expect(await reader.read()).toBe(true);
            expect(Number(reader.getValue(0))).toBe(1);
            
            expect(await reader.nextResult()).toBe(true);
            expect(await reader.read()).toBe(true);
            expect(Number(reader.getValue(0))).toBe(2);
            
            await reader.close();
        });
    });

    describe('Error Handling', () => {
        test('Invalid SQL throws error', async () => {
            const cmd = conn.createCommand('SELECT INVALID_SYNTAX');
            await expect(cmd.executeReader()).rejects.toThrow();
        });

        test('Division by zero throws error', async () => {
            const cmd = conn.createCommand('SELECT 1/0');
            await expect(cmd.executeReader()).rejects.toThrow();
        });
    });
});
