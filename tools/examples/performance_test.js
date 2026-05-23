const { performance } = require('perf_hooks');
const path = require('path');
const fs = require('fs');

// --- Driver imports ---
const { NzConnection } = require('../../dist');

let odbc = null;
let ODBC_AVAILABLE = false;
try {
    odbc = require('odbc');
    ODBC_AVAILABLE = true;
} catch { }

let nodeNetezza = null;
let NODE_NETEZZA_AVAILABLE = false;
try {
    nodeNetezza = require('node-netezza');
    NODE_NETEZZA_AVAILABLE = true;
} catch { }

// --- Connection configuration ---
const HOST = process.env.NZ_HOST || '192.168.0.144';
const PORT = parseInt(process.env.NZ_PORT || '5480', 10);
const USER = process.env.NZ_USER || 'admin';
const PASSWORD = process.env.NZ_PASSWORD || 'password';
const DATABASE = process.env.NZ_DATABASE || 'SYSTEM';
const ROW_LIMIT = parseInt(process.env.NZ_ROWS || '100000', 10);
const SOURCE_TABLE = process.env.NZ_SOURCE_TABLE || 'JUST_DATA..FACTPRODUCTINVENTORY';
const WARMUP_REPS = parseInt(process.env.NZ_BENCH_WARMUP || '1', 10);
const OUTPUT_PATH = process.env.NZ_OUTPUT || null;

const OUTPUT_LINES = [];

// --- Queries (identical to Python version) ---
const QUERIES = {
    integer_types: `
        SELECT
            (RANDOM()*10000)::INT       AS col_int,
            (RANDOM()*10000)::BIGINT    AS col_bigint,
            (RANDOM()*100)::SMALLINT    AS col_smallint,
            (RANDOM()*10)::BYTEINT      AS col_byteint
        FROM ${SOURCE_TABLE}
        LIMIT ${ROW_LIMIT}
    `,
    numeric_types: `
        SELECT
            (RANDOM()*10000)::NUMERIC(20,4)  AS col_numeric,
            (RANDOM()*10000)::DECIMAL(18,2)  AS col_decimal,
            (RANDOM()*10000)::REAL           AS col_real,
            (RANDOM()*10000)::DOUBLE PRECISION AS col_double
        FROM ${SOURCE_TABLE}
        LIMIT ${ROW_LIMIT}
    `,
    string_types: `
        SELECT
            (RANDOM()*10000)::VARCHAR(50)  AS col_varchar,
            (RANDOM()*10000)::NVARCHAR(50) AS col_nvarchar,
            (RANDOM()*10000)::CHAR(20)     AS col_char
        FROM ${SOURCE_TABLE}
        LIMIT ${ROW_LIMIT}
    `,
    datetime_types: `
        SELECT
            CURRENT_DATE + (RANDOM()*365)::INT    AS col_date,
            CURRENT_TIME                          AS col_time,
            CURRENT_TIMESTAMP                     AS col_timestamp
        FROM ${SOURCE_TABLE}
        LIMIT ${ROW_LIMIT}
    `,
    boolean_types: `
        SELECT
            CASE WHEN RANDOM() > 0.5 THEN TRUE  ELSE FALSE END AS col_bool,
            CASE WHEN RANDOM() > 0.5 THEN TRUE  ELSE FALSE END AS col_boolean
        FROM ${SOURCE_TABLE}
        LIMIT ${ROW_LIMIT}
    `,
};

QUERIES.all_types = `
    SELECT
        (RANDOM()*10000)::INT              AS col_int,
        (RANDOM()*10000)::BIGINT           AS col_bigint,
        (RANDOM()*100)::SMALLINT           AS col_smallint,
        (RANDOM()*10)::BYTEINT             AS col_byteint,
        (RANDOM()*10000)::NUMERIC(20,4)    AS col_numeric,
        (RANDOM()*10000)::DECIMAL(18,2)    AS col_decimal,
        (RANDOM()*10000)::REAL             AS col_real,
        (RANDOM()*10000)::DOUBLE PRECISION AS col_double,
        (RANDOM()*10000)::VARCHAR(50)      AS col_varchar,
        (RANDOM()*10000)::NVARCHAR(50)     AS col_nvarchar,
        (RANDOM()*10000)::CHAR(20)         AS col_char,
        CURRENT_DATE + (RANDOM()*365)::INT AS col_date,
        CURRENT_TIME                       AS col_time,
        CURRENT_TIMESTAMP                  AS col_timestamp,
        CASE WHEN RANDOM() > 0.5 THEN TRUE ELSE FALSE END AS col_bool
    FROM ${SOURCE_TABLE}
    LIMIT ${ROW_LIMIT}
`;

const DRIVER_NAMES = [
    'node_netezza',
    'odbc',
    'justybase_native',
];

// --- Helpers ---

function out(...args) {
    const line = args.join(' ');
    console.log(line);
    OUTPUT_LINES.push(line);
}

function fmtNum(n) {
    return n.toLocaleString('en-US').replace(/,/g, ' ');
}

function fmtRps(rps) {
    return rps.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function fmtRpsShort(rps) {
    const s = rps.toFixed(0);
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// --- Connection helpers ---

async function connectJustybase() {
    const conn = new NzConnection({
        host: HOST, port: PORT, database: DATABASE,
        user: USER, password: PASSWORD,
    });
    await conn.connect();
    return conn;
}

async function connectOdbc() {
    const connStr = `DRIVER={NetezzaSQL};SERVER=${HOST};PORT=${PORT};DATABASE=${DATABASE};UID=${USER};PWD=${PASSWORD};`;
    return await odbc.connect(connStr);
}

async function connectNodeNetezza() {
    return await nodeNetezza.connect({
        host: HOST, port: PORT, database: DATABASE,
        user: USER, password: PASSWORD,
    });
}

// --- Query executors ---

async function runQueryJustybase(conn, query) {
    const command = conn.createCommand(query);
    const reader = await command.executeReader();
    let count = 0;
    while (await reader.read()) {
        for (let i = 0; i < reader.fieldCount; i++) {
            reader.getValue(i);
        }
        count++;
    }
    await reader.close();
    return count;
}

async function runQueryOdbc(conn, query) {
    const rows = await conn.query(query);
    for (const row of rows) {
        for (const key in row) { const v = row[key]; }
    }
    return rows.length;
}

async function runQueryNodeNetezza(conn, query) {
    const result = await conn.execute(query);
    for (const row of result.rows) {
        for (const key in row) { const v = row[key]; }
    }
    return result.rows.length;
}

// --- Bench runner ---

async function benchJustybase(label, query, results) {
    let conn;
    try {
        const t0 = performance.now();
        conn = await connectJustybase();
        const ct = performance.now() - t0;
        out(`  ${label}: Connected in ${(ct / 1000).toFixed(4)}s`);

        out(`  ${label}: Executing...`, '');
        const start = performance.now();
        const count = await runQueryJustybase(conn, query);
        const elapsed = performance.now() - start;
        const rps = count / (elapsed / 1000);
        out(`fetched ${fmtNum(count)} rows in ${(elapsed / 1000).toFixed(4)}s (${fmtRps(rps)} rows/s)`);
        results[label] = { queryTime: elapsed / 1000, rowsPerSecond: rps, rowCount: count };
    } catch (e) {
        out(`  ${label}: ERROR - ${e.message}`);
        results[label] = { error: e.message };
    } finally {
        if (conn) { try { conn.close(); } catch { } }
    }
}

async function benchOdbc(label, query, results) {
    let conn;
    try {
        const connStr = `DRIVER={NetezzaSQL};SERVER=${HOST};PORT=${PORT};DATABASE=${DATABASE};UID=${USER};PWD=${PASSWORD};`;
        const t0 = performance.now();
        conn = await odbc.connect(connStr);
        const ct = performance.now() - t0;
        out(`  ${label}: Connected in ${(ct / 1000).toFixed(4)}s`);

        out(`  ${label}: Executing...`, '');
        const start = performance.now();
        const count = await runQueryOdbc(conn, query);
        const elapsed = performance.now() - start;
        const rps = count / (elapsed / 1000);
        out(`fetched ${fmtNum(count)} rows in ${(elapsed / 1000).toFixed(4)}s (${fmtRps(rps)} rows/s)`);
        results[label] = { queryTime: elapsed / 1000, rowsPerSecond: rps, rowCount: count };
    } catch (e) {
        out(`  ${label}: ERROR - ${e.message}`);
        results[label] = { error: e.message };
    } finally {
        if (conn) { try { await conn.close(); } catch { } }
    }
}

async function benchNodeNetezza(label, query, results) {
    let conn;
    try {
        const t0 = performance.now();
        conn = await connectNodeNetezza();
        const ct = performance.now() - t0;
        out(`  ${label}: Connected in ${(ct / 1000).toFixed(4)}s`);

        out(`  ${label}: Executing...`, '');
        const start = performance.now();
        const count = await runQueryNodeNetezza(conn, query);
        const elapsed = performance.now() - start;
        const rps = count / (elapsed / 1000);
        out(`fetched ${fmtNum(count)} rows in ${(elapsed / 1000).toFixed(4)}s (${fmtRps(rps)} rows/s)`);
        results[label] = { queryTime: elapsed / 1000, rowsPerSecond: rps, rowCount: count };
    } catch (e) {
        out(`  ${label}: ERROR - ${e.message}`);
        results[label] = { error: e.message };
    } finally {
        if (conn) { try { await conn.close(); } catch { } }
    }
}

async function runSingleType(typeName, query) {
    const results = {};

    if (NODE_NETEZZA_AVAILABLE) {
        await benchNodeNetezza('node_netezza', query, results);
    }

    if (ODBC_AVAILABLE) {
        await benchOdbc('odbc', query, results);
    }

    await benchJustybase('justybase_native', query, results);

    return results;
}

function printBar(label, rps, maxRps) {
    const barLen = maxRps > 0 ? Math.round((rps / maxRps) * 40) : 0;
    const bar = '#'.repeat(barLen) + '-'.repeat(40 - barLen);
    out(`  ${label.padEnd(30)} [${bar}] ${fmtRps(rps).padStart(12)} rows/s`);
}

async function runPerformanceTest() {
    out('--- justybase_netezza_node_driver performance test (data-type breakdown) ---');
    out(`Host: ${HOST}:${PORT}, DB: ${DATABASE}, Rows: ${fmtNum(ROW_LIMIT)}`);
    out(`node-netezza: ${NODE_NETEZZA_AVAILABLE},  ODBC: ${ODBC_AVAILABLE}`);
    out('');

    const allResults = {};

    for (const [typeName, query] of Object.entries(QUERIES)) {
        const header = typeName.replace(/_/g, ' ').toUpperCase();
        out(`─── ${header} ───`);
        const drvResults = await runSingleType(typeName, query);
        allResults[typeName] = drvResults;
        out('');
    }

    // ── Per-type summary ────────────────────────────────────────────────
    out('='.repeat(68));
    out('  PER-TYPE × DRIVER COMPARISON (rows/s)');
    out('='.repeat(68));

    let headerRow = '  '.padEnd(20);
    for (const d of DRIVER_NAMES) {
        headerRow += `  ${d.padStart(16)}`;
    }
    out(headerRow);
    out('  ' + '-'.repeat(20 + 18 * DRIVER_NAMES.length));

    for (const typeName of Object.keys(QUERIES)) {
        let row = `  ${typeName.padEnd(20)}`;
        for (const d of DRIVER_NAMES) {
            const r = allResults[typeName]?.[d];
            if (r && !r.error) {
                row += `  ${fmtRps(r.rowsPerSecond).padStart(16)}`;
            } else if (r) {
                row += `  ${'ERROR'.padStart(16)}`;
            } else {
                row += `  ${'N/A'.padStart(16)}`;
            }
        }
        out(row);
    }

    // ── Visual bars ─────────────────────────────────────────────────────
    out('');
    for (const typeName of Object.keys(QUERIES)) {
        const drvResults = allResults[typeName] || {};
        const valid = Object.fromEntries(
            Object.entries(drvResults).filter(([, v]) => !v.error)
        );
        if (Object.keys(valid).length === 0) continue;
        const maxRps = Math.max(...Object.values(valid).map(v => v.rowsPerSecond));
        out(`  [${typeName}]`);
        for (const d of DRIVER_NAMES) {
            const r = valid[d];
            if (r) printBar(d, r.rowsPerSecond, maxRps);
        }
        out('');
    }

    // ── Detailed timings ─────────────────────────────────────────────────
    out('='.repeat(68));
    out('  DETAILED TIMINGS');
    out('='.repeat(68));

    for (const typeName of Object.keys(QUERIES)) {
        for (const [driverName, r] of Object.entries(allResults[typeName] || {})) {
            if (!r.error) {
                out(
                    `  ${typeName.padEnd(20)}  ${driverName.padEnd(20)}  ` +
                    `${(r.queryTime).toFixed(4)}s  |  ` +
                    `${fmtRps(r.rowsPerSecond).padStart(12)} rows/s  |  ` +
                    `${fmtNum(r.rowCount)} rows`
                );
            } else {
                out(
                    `  ${typeName.padEnd(20)}  ${driverName.padEnd(20)}  ` +
                    `ERROR - ${r.error}`
                );
            }
        }
    }

    // ── Save to TXT ──────────────────────────────────────────────────────
    if (OUTPUT_PATH) {
        fs.writeFileSync(OUTPUT_PATH, OUTPUT_LINES.join('\n') + '\n', 'utf-8');
        out(`\nResults saved to: ${OUTPUT_PATH}`);
    }
}

// --- CLI ---
const args = process.argv.slice(2);
let outputArg = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') {
        outputArg = args[i + 1];
        i++;
    }
}
if (outputArg) {
    process.env.NZ_OUTPUT = outputArg;
}

runPerformanceTest().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
