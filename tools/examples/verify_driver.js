
const fs = require('fs');
const path = require('path');
const odbc = require('odbc');
const { NzConnection } = require('../../dist');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const connectionString = `DRIVER={NetezzaSQL};SERVER=${config.host};PORT=${config.port};DATABASE=${config.database};UID=${config.user};PWD=${config.password};`;

const LOG_DIR = __dirname;

const TABLES = [
    {
        name: 'DIMDATE',
        orderBy: 'DATEKEY',
        referenceFile: path.join(__dirname, 'js_DIMDATE_REFERENCE.dat')
    },
    {
        name: 'DIMACCOUNT',
        orderBy: 'ACCOUNTKEY',
        referenceFile: path.join(__dirname, 'js_dimaccount_REFERENCE.dat')
    }
];

async function run() {
    let conn;
    let odbcConn;
    try {
        console.log("Connecting our logic...");
        conn = new NzConnection(config);
        await conn.connect();
        console.log("Connected our logic.");

        console.log("Connecting ODBC...");
        try {
            odbcConn = await odbc.connect({
                connectionString,
                fetchArray: true
            });
            console.log("Connected ODBC.");
        } catch (e) {
            console.error("ODBC Connection Failed:", e);
            // Don't fail the whole script if ODBC is optional for reproduce_issue basic flow, 
            // but user REQUESTED verification, so maybe we should. Let's proceed but warn.
        }

        const queries = [
            "SELECT * FROM JUST_DATA.ADMIN.DIMDATE ORDER BY DATEKEY",
            "SELECT * FROM JUST_DATA.ADMIN.DIMACCOUNT ORDER BY ACCOUNTKEY",
            "SELECT * FROM JUST_DATA.ADMIN.DIMORGANIZATION ORDER BY ORGANIZATIONKEY",
            "SELECT * FROM JUST_DATA.ADMIN.FACTFINANCE ORDER BY FINANCEKEY"
        ];

        console.log("Note: This script performs EXPORT (reproducing hang/size check) AND IMPORT (verifying data integrity).");

        // --- NEW VERIFICATION STEP ---
        if (odbcConn) {
            for (const sql of queries) {
                await verifySpecificQuery(conn, odbcConn, sql);
            }
        }
        // -----------------------------

        for (const table of TABLES) {
            await processTable(conn, table);
        }

    } catch (err) {
        console.error("Test Error:", err);
    } finally {
        if (conn) {
            await conn.close();
            console.log("\nConnection closed.");
        }
        if (odbcConn) {
            await odbcConn.close();
            console.log("ODBC Connection closed.");
        }
    }
}

async function verifySpecificQuery(conn, odbcConn, sql) {
    console.log("\n=========================================");
    console.log("VERIFYING SPECIFIC QUERY CONSISTENCY");
    console.log("=========================================");

    // const sql = "SELECT * FROM JUST_DATA.ADMIN.DIMDATE ORDER BY DATEKEY"; // REMOVED
    console.log(`Executing: ${sql}`);

    // JS Driver
    const cmd = conn.createCommand(sql);
    const reader = await cmd.executeReader();
    // reader.read() loop to get all rows
    const jsRows = [];
    while (await reader.read()) {
        const row = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            row.push(reader.getValue(i));
        }
        jsRows.push(row);
    }

    // ODBC Driver
    const odbcRows = await odbcConn.query(sql);

    console.log(`JS Driver Rows: ${jsRows.length}`);
    console.log(`ODBC Driver Rows: ${odbcRows.length}`);

    if (jsRows.length !== odbcRows.length) {
        console.error("FAILURE: Row counts verifySpecificQuery differ!");
        return;
    }

    let diffCount = 0;
    for (let i = 0; i < jsRows.length; i++) {
        const jsRow = jsRows[i];
        const odbcRow = odbcRows[i]; // Arrays because fetchArray: true

        for (let j = 0; j < jsRow.length; j++) {
            let valJs = jsRow[j];
            let valOdbc = odbcRow[j];

            // Normalize for comparison
            if (typeof valJs === 'string') valJs = valJs.trim();
            if (typeof valOdbc === 'string') valOdbc = valOdbc.trim();

            // Handle Dates/Nulls if necessary (simple equality check first).
            // Loose coercion is avoided; coerced-equal values are caught below by the String() comparison.
            if (valJs !== valOdbc) {
                // Check if it's a date mismatch due to TZ/format
                // JS: 'Sat Jan 01 2005 01:00:00 GMT+0100' (Date object toString)
                // ODBC: '2005-01-01 00:00:00'
                if (valJs instanceof Date && typeof valOdbc === 'string') {
                    // Convert JS date to YYYY-MM-DD HH:mm:ss for comparison, ignoring TZ for this test
                    // Extract YYYY-MM-DD from JS Date
                    const yyyy = valJs.getFullYear();
                    const mm = String(valJs.getMonth() + 1).padStart(2, '0');
                    const dd = String(valJs.getDate()).padStart(2, '0');
                    const hh = String(valJs.getHours()).padStart(2, '0');
                    const mi = String(valJs.getMinutes()).padStart(2, '0');
                    const ss = String(valJs.getSeconds()).padStart(2, '0');

                    const jsIsoLike = `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;

                    // Simple check: does the ODBC string start with the YYYY-MM-DD part of JS date?
                    // This is loose but fits the user requirement "consider as compatible" for that specific mismatch style.
                    const jsDatePart = `${yyyy}-${mm}-${dd}`;
                    if (valOdbc.startsWith(jsDatePart)) {
                        continue; // Considered match
                    }
                }

                // Loose comparison for now just in case
                if (String(valJs) !== String(valOdbc)) {
                    console.error(`Row ${i} Col ${j} Mismatch: JS='${valJs}' vs ODBC='${valOdbc}'`);
                    diffCount++;
                    if (diffCount > 10) {
                        console.error("Too many diffs, stopping log.");
                        break;
                    }
                }
            }
        }
        if (diffCount > 10) break;
    }

    if (diffCount === 0) {
        console.log("SUCCESS: Query results identical.");
    } else {
        console.error(`FAILURE: Found ${diffCount} mismatches.`);
    }
}

async function processTable(conn, table) {
    const tableName = table.name;
    const outputFile = path.join(__dirname, `js_${tableName}.dat`);
    const targetTable = `${tableName}_IMPORT_TEST`;

    console.log(`\n========================================`);
    console.log(`PROCESSING TABLE: ${tableName}`);
    console.log(`========================================`);

    // --- 0. PREPARATION ---
    if (fs.existsSync(outputFile)) {
        fs.unlinkSync(outputFile);
        console.log("Deleted existing output file.");
    }
    await conn.createCommand(`DROP TABLE ${targetTable} IF EXISTS`).executeNonQuery();

    // --- 1. EXPORT ---
    const exportSql = `CREATE EXTERNAL TABLE '${outputFile}' 
USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${LOG_DIR}') 
AS SELECT * FROM ${tableName} order by ${table.orderBy}`;

    console.log("\n--- EXPORT ---");
    console.log("Executing EXPORT SQL:", exportSql);
    const cmd = conn.createCommand(exportSql);
    cmd.commandTimeout = 0; // Infinite timeout
    await cmd.executeNonQuery();
    console.log("Export execution finished.");

    // Verify File Size
    if (fs.existsSync(outputFile)) {
        const outputStats = fs.statSync(outputFile);
        console.log(`Output size: ${outputStats.size} bytes`);

        if (table.referenceFile && fs.existsSync(table.referenceFile)) {
            const refStats = fs.statSync(table.referenceFile);
            console.log(`Reference size: ${refStats.size} bytes`);

            if (outputStats.size === refStats.size) {
                console.log("SUCCESS: File sizes match.");
            } else {
                console.log("FAILURE: File sizes DO NOT match!");
            }
        }
    } else {
        console.error("FAILURE: Output file was NOT created.");
        return;
    }

    // --- 2. IMPORT ---
    console.log("\n--- IMPORT ---");
    // Create target table structure (empty)
    await conn.createCommand(`CREATE TABLE ${targetTable} AS SELECT * FROM ${tableName} WHERE 1=2`).executeNonQuery();
    console.log(`Created target table: ${targetTable}`);

    const importSql = `INSERT INTO ${targetTable} 
                       SELECT * FROM EXTERNAL '${outputFile}' 
                       USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${LOG_DIR}')`;

    console.log(`Executing IMPORT SQL: ${importSql}`);
    await conn.createCommand(importSql).executeNonQuery();
    console.log('Import execution finished.');

    // --- 3. VERIFICATION (Row Counts) ---
    console.log('\n--- DATA VERIFICATION ---');
    const countOrg = await conn.executeScalar(`SELECT COUNT(1) FROM ${tableName}`);
    const countNew = await conn.executeScalar(`SELECT COUNT(1) FROM ${targetTable}`);

    console.log(`Original Row Count: ${countOrg}`);
    console.log(`Imported Row Count: ${countNew}`);

    if (Number(countOrg) === Number(countNew)) {
        console.log('SUCCESS: Row counts match.');
    } else {
        console.error('FAILURE: Row counts do not match!');
    }
}


run();
