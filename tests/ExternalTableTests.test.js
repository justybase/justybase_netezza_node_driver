const fs = require('fs');
const path = require('path');
const { NzConnection } = require('../dist/NzConnection');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const TEMP_DIR = 'd:\\TMP';
const TEST_FILE = path.join(TEMP_DIR, 'js_et_test.dat');

// Helper to read single value from a query
async function readSingleValue(conn, sql) {
    const reader = await conn.createCommand(sql).executeReader();
    let value = null;
    if (await reader.read()) {
        value = reader.getValue(0);
    }
    await reader.close();
    return value;
}

// Helper to read all rows
async function readAllRows(reader) {
    const rows = [];
    while (await reader.read()) {
        const row = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            row.push(reader.getValue(i));
        }
        rows.push(row);
    }
    await reader.close();
    return rows;
}

describe('NzDriver - External Tables', () => {
    let conn;

    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();

        if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    });

    afterAll(() => {
        if (conn) conn.close();
        if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
        // Cleanup other potential test files
        ['DIMPRODUCT', 'DIMCURRENCY', 'DIMDATE', 'DIMACCOUNT_EXT'].forEach(t => {
            const f = path.join(TEMP_DIR, `${t}.dat`);
            if (fs.existsSync(f)) fs.unlinkSync(f);
        });
    });

    test('Should create external table (Export)', async () => {
        const cmd = conn.createCommand("CREATE TEMP TABLE ET_SOURCE AS SELECT 1 AS ID, 'Test' AS VAL");
        await cmd.executeNonQuery();

        // Note: REMOTESOURCE 'jdbc' is used to mimic valid usage
        const sql = `CREATE EXTERNAL TABLE '${TEST_FILE}' 
                     USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${TEMP_DIR}') 
                     AS SELECT * FROM ET_SOURCE`;

        const extCmd = conn.createCommand(sql);
        await extCmd.executeNonQuery();

        expect(fs.existsSync(TEST_FILE)).toBe(true);
        const content = fs.readFileSync(TEST_FILE, 'utf8');
        expect(content).toContain('1|Test');
    });

    test('Should read from external table (Import)', async () => {
        const cmd = conn.createCommand("CREATE TEMP TABLE ET_DEST (ID INT, VAL VARCHAR(20))");
        await cmd.executeNonQuery();

        const sql = `INSERT INTO ET_DEST 
                     SELECT * FROM EXTERNAL '${TEST_FILE}' 
                     USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${TEMP_DIR}')`;

        const extCmd = conn.createCommand(sql);
        await extCmd.executeNonQuery();

        const verifyCmd = conn.createCommand("SELECT * FROM ET_DEST");
        const reader = await verifyCmd.executeReader();
        const rows = await readAllRows(reader);

        expect(rows.length).toBe(1);
        expect(rows[0][0]).toBe(1);
        expect(rows[0][1]).toBe('Test');
    });

    // Multi-table test matching C# TestExternalTable
    const tablesToTest = ['DIMPRODUCT', 'DIMCURRENCY', 'DIMDATE'];
    test.each(tablesToTest)('Should export and import %s correctly', async (tableName) => {
        const externalPath = path.join(TEMP_DIR, `${tableName}.dat`);
        const tableOrg = tableName; // Assuming tables are in default schema/path or just use name if in JUST_DATA..
        const tableNew = `${tableName}_FROM_EXTERNAL`;

        // Cleanup
        if (fs.existsSync(externalPath)) fs.unlinkSync(externalPath);
        await conn.createCommand(`DROP TABLE ${tableNew} IF EXISTS`).executeNonQuery();
        await conn.createCommand(`DROP TABLE ET_TEMP_${tableName} IF EXISTS`).executeNonQuery();

        // 1. Export to External Table
        // Use REMOTESOURCE 'jdbc' as per other tests
        const exportSql = `CREATE EXTERNAL TABLE '${externalPath}' USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${TEMP_DIR}') AS SELECT * FROM ${tableOrg}`;
        await conn.createCommand(exportSql).executeNonQuery();

        expect(fs.existsSync(externalPath)).toBe(true);

        // 2. Create Destination Table
        await conn.createCommand(`CREATE TABLE ${tableNew} AS SELECT * FROM ${tableOrg} WHERE 1=2`).executeNonQuery();

        // 3. Import from External Table
        const importSql = `INSERT INTO ${tableNew} SELECT * FROM EXTERNAL '${externalPath}' USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${TEMP_DIR}')`;
        await conn.createCommand(importSql).executeNonQuery();

        // 4. Verify Counts
        const countOrg = await readSingleValue(conn, `SELECT COUNT(1) FROM ${tableOrg}`);
        const countNew = await readSingleValue(conn, `SELECT COUNT(1) FROM ${tableNew}`);

        expect(Number(countNew)).toBe(Number(countOrg));

        // 5. Verify Content (Minus)
        // Note: MINUS in Netezza. If result is empty, tables match.
        const minusSql = `SELECT * FROM ${tableNew} MINUS SELECT * FROM ${tableOrg}`;
        const reader = await conn.createCommand(minusSql).executeReader();
        const rows = await readAllRows(reader);
        expect(rows.length).toBe(0);

        // Cleanup
        await conn.createCommand(`DROP TABLE ${tableNew} IF EXISTS`).executeNonQuery();
        if (fs.existsSync(externalPath)) fs.unlinkSync(externalPath);
    }, 60000); // Increased timeout for multi-table ops

    test('CompressedExternalTableReadShouldNotThrow', async () => {
        const tableName = 'DIMDATE'; // Switch to DIMDATE to avoid distribution mismatch
        const externalPath = path.join(TEMP_DIR, `${tableName}_EXT.DAT`);
        const tableTmp = `${tableName}_TMP`;

        // Cleanup
        if (fs.existsSync(externalPath)) fs.unlinkSync(externalPath);
        await conn.createCommand(`DROP TABLE ${tableTmp} IF EXISTS`).executeNonQuery();

        // 1. Export COMPRESSED
        // Note: Using COMPRESS 'TRUE'
        const exportSql = `CREATE EXTERNAL TABLE '${externalPath}' 
                           USING (REMOTESOURCE 'jdbc' FORMAT 'INTERNAL' COMPRESS 'TRUE') 
                           AS SELECT * FROM ${tableName}`;
        await conn.createCommand(exportSql).executeNonQuery();

        expect(fs.existsSync(externalPath)).toBe(true);

        // 2. Create Temp Table Logic
        // In C# it inserts into DIMACCOUNT_TMP. Let's create it first.
        // Explicitly use DISTRIBUTE ON RANDOM to avoid "Reload distribution algorithm mismatch" with Internal format
        await conn.createCommand(`CREATE TABLE ${tableTmp} AS SELECT * FROM ${tableName} WHERE 1=2 DISTRIBUTE ON RANDOM`).executeNonQuery();

        // 3. Import COMPRESSED
        const importSql = `INSERT INTO ${tableTmp} 
                           SELECT * FROM EXTERNAL '${externalPath}' 
                           USING (REMOTESOURCE 'jdbc' FORMAT 'INTERNAL' COMPRESS 'TRUE')`;
        await conn.createCommand(importSql).executeNonQuery();

        // 4. Verify Content
        const diffCount = await readSingleValue(conn, `SELECT COUNT(1) FROM (SELECT * FROM ${tableTmp} MINUS SELECT * FROM ${tableName}) X`);
        expect(Number(diffCount)).toBe(0);

        const totalCount = await readSingleValue(conn, `SELECT COUNT(1) FROM ${tableTmp}`);
        expect(Number(totalCount)).toBeGreaterThan(0);

        // Cleanup
        await conn.createCommand(`DROP TABLE ${tableTmp} IF EXISTS`).executeNonQuery();
        if (fs.existsSync(externalPath)) fs.unlinkSync(externalPath);
    });
});
