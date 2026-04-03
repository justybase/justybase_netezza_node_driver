const { NzConnection } = require('../dist/NzConnection');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Formats a time object to HH:mm:ss string.
 */
function formatTimeValue(val) {
    if (typeof val === 'object' && val !== null && val.hours !== undefined) {
        return `${String(val.hours).padStart(2, '0')}:${String(val.minutes).padStart(2, '0')}:${String(val.seconds).padStart(2, '0')}`;
    }
    return String(val);
}

/**
 * Gets the type name of a value (similar to C# GetType().Name).
 */
function getTypeName(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (val instanceof Date) return 'Date';
    if (Array.isArray(val)) return 'Array';
    if (typeof val === 'object') return 'Object';
    const t = typeof val;
    return t.charAt(0).toUpperCase() + t.slice(1);
}

// ============================================================================
// Test Cases
// ============================================================================

const selectWithVsWithoutTableCases = [
    [
        "SELECT true::BOOLEAN FROM JUST_DATA..DIMDATE LIMIT 1",
        "SELECT true::BOOLEAN"
    ],
    [
        "SELECT '2024-12-11'::DATE FROM JUST_DATA..DIMDATE LIMIT 1",
        "SELECT '2024-12-11'::DATE"
    ],
    [
        "SELECT '2024-12-11 14:30:00'::TIMESTAMP FROM JUST_DATA..DIMDATE LIMIT 1",
        "SELECT '2024-12-11 14:30:00'::TIMESTAMP"
    ],
    [
        "SELECT 123.456::NUMERIC(10,3) FROM JUST_DATA..DIMDATE LIMIT 1",
        "SELECT 123.456::NUMERIC(10,3)"
    ],
    [
        "SELECT 3.1400::NUMERIC(10,4) FROM JUST_DATA..DIMDATE LIMIT 1",
        "SELECT 3.1400::NUMERIC(10,4)"
    ],
    [
        "SELECT '2 years 5 hours 11 months 41 minutes 15 sec'::interval FROM JUST_DATA..DIMDATE LIMIT 1",
        "SELECT '2 years 5 hours 11 months 41 minutes 15 sec'::interval"
    ],
    [
        "SELECT '5 hours 41 minutes  15 sec'::interval FROM JUST_DATA..DIMDATE LIMIT 1",
        "SELECT '5 hours 41 minutes  15 sec'::interval"
    ],
    [
        "SELECT '05:41:15'::TIME FROM JUST_DATA..DIMDATE LIMIT 1",
        "SELECT '05:41:15'::TIME"
    ],
    [
        "SELECT TO_CHAR(NOW(), 'YYYY-MM-DD HH24') AS formatted_timestamp_01 FROM JUST_DATA..DIMACCOUNT LIMIT 1",
        "SELECT TO_CHAR(NOW(), 'YYYY-MM-DD HH24') AS formatted_timestamp_02"
    ],
];

// ============================================================================
// Test Suite
// ============================================================================

describe('SELECT FROM TABLE vs SELECT consistency', () => {
    let nzConn;

    beforeAll(async () => {
        nzConn = new NzConnection(config);
        await nzConn.connect();
    });

    afterAll(async () => {
        if (nzConn) nzConn.close();
    });

    test.each(selectWithVsWithoutTableCases)(
        'Results should match: %s vs %s',
        async (queryWithTable, queryWithoutTable) => {
            // Execute query WITH table
            const cmd1 = nzConn.createCommand(queryWithTable);
            const reader1 = await cmd1.executeReader();
            expect(await reader1.read()).toBe(true);
            const val1 = reader1.getValue(0);
            const formatted1 = formatTimeValue(val1);
            const type1 = getTypeName(val1);
            await reader1.close();

            // Execute query WITHOUT table
            const cmd2 = nzConn.createCommand(queryWithoutTable);
            const reader2 = await cmd2.executeReader();
            expect(await reader2.read()).toBe(true);
            const val2 = reader2.getValue(0);
            const formatted2 = formatTimeValue(val2);
            const type2 = getTypeName(val2);
            await reader2.close();

            console.log('Test Case:', queryWithoutTable);
            console.log('Table Value:', val1, 'Formatted:', formatted1, 'Type:', type1);
            console.log('Const Value:', val2, 'Formatted:', formatted2, 'Type:', type2);

            // Compare results
            expect(formatted1).toBe(formatted2);
            expect(type1).toBe(type2);
        },
        60000
    );
});
