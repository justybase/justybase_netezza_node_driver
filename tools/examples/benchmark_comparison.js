const { run, bench, group } = require('mitata');
const odbc = require('odbc');
const { NzConnection } = require('../../dist');
const { connect: nzConnect } = require('node-netezza');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const connectionString = `DRIVER={NetezzaSQL};SERVER=${config.host};PORT=${config.port};DATABASE=${config.database};UID=${config.user};PWD=${config.password};`;

const QUERY = "SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY ORDER BY ROWID LIMIT 100000";
const TABLE_FOR_EXPORT = "JUST_DATA..FACTPRODUCTINVENTORY";
const TEMP_DIR = process.env.NZ_LOCAL_TMP_DIR || path.join(os.tmpdir(), 'justybase-netezza-driver');
const EXT_FILE_JS = path.join(TEMP_DIR, 'bench_js.dat');
const EXT_FILE_ODBC = path.join(TEMP_DIR, 'bench_odbc.dat');

// Ensure temp dir exists
if (!fs.existsSync(TEMP_DIR)) {
    try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch (e) { }
}

async function main() {

    // -------------------------------------------------------------------------
    // 1. Connection Overhead Benchmarks
    // -------------------------------------------------------------------------
    group('Connection Overhead (Connect -> Close)', () => {

        bench('state-of-the-art (node-netezza)', async () => {
            const conn = await nzConnect(config);
            await conn.close();
        });

        bench('JsNzDriver (Ours)', async () => {
            const conn = new NzConnection(config);
            await conn.connect();
            await conn.close();
        });

        bench('ODBC Standard', async () => {
            const conn = await odbc.connect(connectionString);
            await conn.close();
        });
    });

    // -------------------------------------------------------------------------
    // 2. Pure Query Benchmarks (Reuse Connection)
    // -------------------------------------------------------------------------
    // Setup connections once
    const nodeNzConn = await nzConnect(config);
    const jsNzConn = new NzConnection(config);
    await jsNzConn.connect();
    const odbcConn = await odbc.connect(connectionString);

    group('Pure SELECT Query (No Connection Overhead)', () => {

        bench('state-of-the-art (node-netezza)', async () => {
            const results = await nodeNzConn.execute(QUERY);
            // Access data to ensure it's read
            for (const row of results.rows) {
                // eslint-disable-next-line no-unused-vars
                for (const key in row) { /* no-op */ }
            }
        });

        bench('JsNzDriver (Ours)', async () => {
            const cmd = jsNzConn.createCommand(QUERY);
            const reader = await cmd.executeReader();
            while (await reader.read()) {
                for (let i = 0; i < reader.fieldCount; i++) {
                    reader.getValue(i);
                }
            }
        });

        bench('ODBC Standard', async () => {
            const result = await odbcConn.query(QUERY);
            if (result.length > 0) { /* no-op */ }
        });
    });

    // -------------------------------------------------------------------------
    // EXPORT Benchmarks (Base -> Disk)
    // -------------------------------------------------------------------------
    group('EXPORT to External Table (Base -> Disk)', () => {

        bench('JsNzDriver Export', async () => {
            // Cleanup before run
            if (fs.existsSync(EXT_FILE_JS)) fs.unlinkSync(EXT_FILE_JS);

            const conn = new NzConnection(config);
            await conn.connect();
            try {
                const sql = `CREATE EXTERNAL TABLE '${EXT_FILE_JS}' 
                              USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${TEMP_DIR}') 
                              AS SELECT * FROM ${TABLE_FOR_EXPORT} LIMIT 10000`;
                const cmd = conn.createCommand(sql);
                await cmd.executeNonQuery();
            } finally {
                await conn.close();
            }
        });

        bench('ODBC Export', async () => {
            // Cleanup before run
            if (fs.existsSync(EXT_FILE_ODBC)) fs.unlinkSync(EXT_FILE_ODBC);

            const conn = await odbc.connect(connectionString);
            try {
                const sql = `CREATE EXTERNAL TABLE '${EXT_FILE_ODBC}' 
                             USING (REMOTESOURCE 'ODBC' DELIMITER '|' LOGDIR '${TEMP_DIR}') 
                             AS SELECT * FROM ${TABLE_FOR_EXPORT} LIMIT 10000`;
                await conn.query(sql);
            } finally {
                await conn.close();
            }
        });
    });

    // -------------------------------------------------------------------------
    // IMPORT Benchmarks (Disk -> Base)
    // -------------------------------------------------------------------------
    // Ensure files exist for import benchmarks
    if (!fs.existsSync(EXT_FILE_JS) || !fs.existsSync(EXT_FILE_ODBC)) {
        console.log("Preparing files for Import benchmark...");
        await prepareImportFiles();
    }

    group('IMPORT from External Table (Disk -> Base)', () => {

        bench('JsNzDriver Import', async () => {
            const tableName = "BENCH_IMPORT_JS_" + Math.floor(Math.random() * 100000);
            const conn = new NzConnection(config);
            await conn.connect();
            try {
                // Prepare: Create empty table
                await conn.createCommand(`CREATE TABLE ${tableName} AS SELECT * FROM ${TABLE_FOR_EXPORT} WHERE 1=2`).executeNonQuery();

                const sql = `INSERT INTO ${tableName} 
                             SELECT * FROM EXTERNAL '${EXT_FILE_JS}' 
                             USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${TEMP_DIR}')`;
                const cmd = conn.createCommand(sql);
                await cmd.executeNonQuery();
            } finally {
                try { await conn.createCommand(`DROP TABLE ${tableName}`).executeNonQuery(); } catch (e) { }
                await conn.close();
            }
        });

        bench('ODBC Import', async () => {
            const tableName = "BENCH_IMPORT_ODBC_" + Math.floor(Math.random() * 100000);
            const conn = await odbc.connect(connectionString);
            try {
                await conn.query(`CREATE TABLE ${tableName} AS SELECT * FROM ${TABLE_FOR_EXPORT} WHERE 1=2`);

                const sql = `INSERT INTO ${tableName} 
                             SELECT * FROM EXTERNAL '${EXT_FILE_ODBC}' 
                             USING (REMOTESOURCE 'ODBC' DELIMITER '|' LOGDIR '${TEMP_DIR}')`;
                await conn.query(sql);

            } finally {
                try { await conn.query(`DROP TABLE ${tableName}`); } catch (e) { }
                await conn.close();
            }
        });
    });

    // Run the benchmarks
    await run({
        avg: true, // average time
        json: false, // print json?
        colors: true, // enable colors
        min_max: true, // min max time
        percentiles: false, // p50, p75, p90, p99
    });

    // -------------------------------------------------------------------------
    // 3. Pure Fetch (Row Processing) - Manual Measurement (Exclude Execute Time)
    // -------------------------------------------------------------------------
    // Mitata doesn't support excluding setup time per iteration easily, so we measure manually.
    console.log("\nRunning Manual Fetch Benchmark (Avg of 3 runs)...");

    // JsNzDriver
    let totalJsTime = 0;
    const iterations = 3;
    for (let i = 0; i < iterations; i++) {
        const cmd = jsNzConn.createCommand(QUERY);
        const reader = await cmd.executeReader();

        const start = performance.now();
        while (await reader.read()) {
            for (let k = 0; k < reader.fieldCount; k++) {
                reader.getValue(k);
            }
        }
        const end = performance.now();
        totalJsTime += (end - start);
    }
    console.log(`JsNzDriver (Fetch Only): ${(totalJsTime / iterations).toFixed(2)} ms`);

    // JsNzDriver (Execute + Fetch) - for fair comparison
    let totalJsExecTime = 0;
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const cmd = jsNzConn.createCommand(QUERY);
        const reader = await cmd.executeReader();
        while (await reader.read()) {
            for (let k = 0; k < reader.fieldCount; k++) {
                reader.getValue(k);
            }
        }
        const end = performance.now();
        totalJsExecTime += (end - start);
    }
    console.log(`JsNzDriver (Execute + Fetch): ${(totalJsExecTime / iterations).toFixed(2)} ms`);

    // ODBC (Note: query() includes execution time, but it's the standard fetching mechanism)
    let totalOdbcTime = 0;
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const res = await odbcConn.query(QUERY);
        // Access ALL data to ensure fair comparison of "processing" 
        // (ODBC usually fetches all to memory in query(), so iteration is fast, but we include it)
        if (res.length > 0) {
            for (const row of res) {
                // touch values
                for (const key in row) { const v = row[key]; }
            }
        }
        const end = performance.now();
        totalOdbcTime += (end - start);
    }
    console.log(`ODBC (Execute + Fetch):  ${(totalOdbcTime / iterations).toFixed(2)} ms`);

    // node-netezza
    let totalNodeNzTime = 0;
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const res = await nodeNzConn.execute(QUERY);
        for (const row of res.rows) {
            for (const key in row) { const v = row[key]; }
        }
        const end = performance.now();
        totalNodeNzTime += (end - start);
    }
    console.log(`node-netezza (Exec+Fetch): ${(totalNodeNzTime / iterations).toFixed(2)} ms\n`);


    // Cleanup global connections
    await nodeNzConn.close();
    await jsNzConn.close();
    await odbcConn.close();
}

async function prepareImportFiles() {
    // Generate JS file if needed
    if (!fs.existsSync(EXT_FILE_JS)) {
        const conn = new NzConnection(config);
        await conn.connect();
        try {
            const sql = `CREATE EXTERNAL TABLE '${EXT_FILE_JS}' 
                         USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${TEMP_DIR}') 
                         AS SELECT * FROM ${TABLE_FOR_EXPORT}`;
            await conn.createCommand(sql).executeNonQuery();
        } catch (e) { console.error("Error preparing JS file:", e); }
        await conn.close();
    }
    // Generate ODBC file if needed
    if (!fs.existsSync(EXT_FILE_ODBC)) {
        const conn = await odbc.connect(connectionString);
        try {
            const sql = `CREATE EXTERNAL TABLE '${EXT_FILE_ODBC}' 
                             USING (REMOTESOURCE 'ODBC' DELIMITER '|' LOGDIR '${TEMP_DIR}') 
                             AS SELECT * FROM ${TABLE_FOR_EXPORT}`;
            await conn.query(sql);
        } catch (e) { console.error("Error preparing ODBC file:", e); }
        await conn.close();
    }
}

main().catch(console.error);
