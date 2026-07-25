const { NzConnection } = require('../dist/cjs/NzConnection');

const { getNzConfig } = require('./helpers/env');
const config = (() => { try { return getNzConfig(); } catch (e) { return null; } })();
const describeNz = config ? describe : describe.skip;


const SQL1 = 'SELECT * FROM JUST_DATA..DIMDATE ORDER BY DATEKEY LIMIT 10';
const SQL2 = 'SELECT * FROM JUST_DATA..DIMACCOUNT ORDER BY ACCOUNTKEY LIMIT 10';

// Helper to read all rows from a reader into an array
async function readAllRows(reader) {
    const rows = [];
    while (await reader.read()) {
        const row = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            row.push(reader.getValue(i));
        }
        rows.push(row);
    }
    return rows;
}

// Normalize values for comparison (handle Date objects, etc)
function normalizeValue(val) {
    if (val === null || val === undefined) return null;
    if (val instanceof Date) return val.toISOString();
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
}

function normalizeRows(rows) {
    return rows.map(row => row.map(normalizeValue));
}

describeNz('NzDriver - Multi-Command Consistency', () => {

    test('Results should be identical: two connections vs one connection two commands vs one command multi-statement', async () => {
        // Approach 1: Two separate connections, each with its own command
        const conn1a = new NzConnection(config);
        const conn1b = new NzConnection(config);
        await conn1a.connect();
        await conn1b.connect();

        const reader1a = await conn1a.createCommand(SQL1).executeReader();
        const rows1a = await readAllRows(reader1a);
        await reader1a.close();

        const reader1b = await conn1b.createCommand(SQL2).executeReader();
        const rows1b = await readAllRows(reader1b);
        await reader1b.close();

        await conn1a.close();
        await conn1b.close();

        // Approach 2: One connection, two separate commands (sequential)
        const conn2 = new NzConnection(config);
        await conn2.connect();

        const reader2a = await conn2.createCommand(SQL1).executeReader();
        const rows2a = await readAllRows(reader2a);
        await reader2a.close();

        const reader2b = await conn2.createCommand(SQL2).executeReader();
        const rows2b = await readAllRows(reader2b);
        await reader2b.close();

        await conn2.close();

        // Approach 3: One connection, one command with multi-statement (semicolon-separated)
        const conn3 = new NzConnection(config);
        await conn3.connect();

        const combinedSQL = `${SQL1};${SQL2}`;
        const reader3 = await conn3.createCommand(combinedSQL).executeReader();

        // Read first result set
        const rows3a = await readAllRows(reader3);

        // Move to second result set
        const hasNext = await reader3.nextResult();
        expect(hasNext).toBe(true);

        // Read second result set
        const rows3b = await readAllRows(reader3);

        await reader3.close();
        await conn3.close();

        // Verify all approaches produced the same results
        const normalized1a = normalizeRows(rows1a);
        const normalized1b = normalizeRows(rows1b);
        const normalized2a = normalizeRows(rows2a);
        const normalized2b = normalizeRows(rows2b);
        const normalized3a = normalizeRows(rows3a);
        const normalized3b = normalizeRows(rows3b);

        // Compare row counts
        expect(rows1a.length).toBeGreaterThan(0);
        expect(rows1b.length).toBeGreaterThan(0);
        expect(rows2a.length).toBe(rows1a.length);
        expect(rows2b.length).toBe(rows1b.length);
        expect(rows3a.length).toBe(rows1a.length);
        expect(rows3b.length).toBe(rows1b.length);

        // Compare actual data
        expect(normalized2a).toEqual(normalized1a);
        expect(normalized2b).toEqual(normalized1b);
        expect(normalized3a).toEqual(normalized1a);
        expect(normalized3b).toEqual(normalized1b);

        console.log(`DIMDATE: ${rows1a.length} rows matched across all 3 approaches`);
        console.log(`DIMACCOUNT: ${rows1b.length} rows matched across all 3 approaches`);
    }, 30000);

    test('One connection should allow multiple sequential command executions', async () => {
        const conn = new NzConnection(config);
        await conn.connect();
        conn.commandTimeout = 0; // Disable automatic timeout for this test

        // Execute multiple commands sequentially on the same connection
        for (let i = 0; i < 5; i++) {
            const reader = await conn.createCommand(`SELECT ${i + 1} AS val`).executeReader();
            expect(await reader.read()).toBe(true);
            // Text format returns strings, so convert to number for comparison
            expect(Number(reader.getValue(0))).toBe(i + 1);
            // Must fully consume or close reader before next command
            while (await reader.read()) { /* consume remaining */ }
        }

        await conn.close();
    });
});
