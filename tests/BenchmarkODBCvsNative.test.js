
const odbc = require('odbc');
const { NzConnection, NzCommand } = require('../dist');
const crypto = require('crypto');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const connectionString = `DRIVER={NetezzaSQL};SERVER=${config.host};PORT=${config.port};DATABASE=${config.database};UID=${config.user};PWD=${config.password};`;

const ROW_COUNT = 100000;

const testQueries = [
    {
        name: 'DIMDATE (10k rows)',
        query: `SELECT * FROM JUST_DATA.ADMIN.DIMDATE ORDER BY ROWID LIMIT ${ROW_COUNT}`
    },
    {
        name: 'FACTPRODUCTINVENTORY (10k rows)',
        query: `SELECT * FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY ORDER BY ROWID LIMIT ${ROW_COUNT}`
    },
    {
        name: 'Many Types Query',
        query: `
            SELECT  
                10::bigint,
                null::bigint,
                true::Boolean,
                false::Boolean,
                null::Boolean,
                5::Byteint,
                null::Byteint,
                'a'::Char,
                null::Char,
                current_date::Date,
                null::Date,
                0.5::float,
                null::float,
                10::integer,
                null::integer,
                '02:00:00'::TIME,
                'abc'::nchar(10),
                null::nchar(10),
                1.54::numeric(30, 6),
                null::numeric(30, 6),
                'abc'::Nvarchar(10),
                null::Nvarchar(10),
                1.54::real,
                null::real,
                5::smallint,
                null::smallint,
                '10:12:13'::TIME,
                null::time,
                DATE_TRUNC('hour', current_timestamp)::Timestamp,
                null::Timestamp,
                'abc'::varchar(10),
                null::varchar(10)
            FROM JUST_DATA..FACTPRODUCTINVENTORY 
            ORDER BY rowid ASC
            LIMIT ${ROW_COUNT}
        `
    }
];

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(ms) {
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function getMemoryUsage() {
    const mem = process.memoryUsage();
    return {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        rss: mem.rss
    };
}

async function benchmarkOdbc(queryName, query) {
    let connection;
    try {
        const startTime = process.hrtime.bigint();
        const startMem = getMemoryUsage();

        connection = await odbc.connect(connectionString);
        const result = await connection.query(query);
        
        const endTime = process.hrtime.bigint();
        const endMem = getMemoryUsage();

        const durationMs = Number(endTime - startTime) / 1e6;
        const rowsCount = result.length;
        const memUsed = endMem.heapUsed - startMem.heapUsed;

        const dataSize = JSON.stringify(result).length;
        const throughput = dataSize / (durationMs / 1000);

        await connection.close();

        return {
            driver: 'ODBC',
            query: queryName,
            duration: durationMs,
            rows: rowsCount,
            memoryUsed: memUsed,
            dataSize: dataSize,
            throughput: throughput,
            rowsPerSecond: rowsCount / (durationMs / 1000)
        };
    } catch (error) {
        if (connection) {
            try { await connection.close(); } catch {}
        }
        throw error;
    }
}

async function benchmarkNativeDriver(queryName, query) {
    let connection;
    try {
        const startTime = process.hrtime.bigint();
        const startMem = getMemoryUsage();

        connection = new NzConnection(config);
        await connection.connect();
        
        const command = connection.createCommand(query);
        const reader = await connection.executeReader(command);
        
        const rows = [];
        while (await reader.read()) {
            const row = [];
            for (let i = 0; i < reader.fieldCount; i++) {
                row.push(reader.getValue(i));
            }
            rows.push(row);
        }
        await reader.close();
        
        const endTime = process.hrtime.bigint();
        const endMem = getMemoryUsage();

        const durationMs = Number(endTime - startTime) / 1e6;
        const rowsCount = rows.length;
        const memUsed = endMem.heapUsed - startMem.heapUsed;

        const dataSize = JSON.stringify(rows, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ).length;
        const throughput = dataSize / (durationMs / 1000);

        connection.close();

        return {
            driver: 'Native',
            query: queryName,
            duration: durationMs,
            rows: rowsCount,
            memoryUsed: memUsed,
            dataSize: dataSize,
            throughput: throughput,
            rowsPerSecond: rowsCount / (durationMs / 1000)
        };
    } catch (error) {
        if (connection) {
            try { connection.close(); } catch {}
        }
        throw error;
    }
}

async function runBenchmark() {
    console.log('\n' + '='.repeat(80));
    console.log('BENCHMARK: ODBC vs Native Driver');
    console.log('='.repeat(80));
    console.log(`Configuration: ${config.host}:${config.port}/${config.database}`);
    console.log(`Row count: ${ROW_COUNT}`);
    console.log(`Platform: ${process.platform} (${process.arch})`);
    console.log(`Node.js: ${process.version}`);
    console.log('='.repeat(80) + '\n');

    const results = [];

    for (const test of testQueries) {
        console.log(`\nTesting: ${test.name}`);
        console.log('-'.repeat(80));

        try {
            console.log('  Running ODBC benchmark...');
            const odbcResult = await benchmarkOdbc(test.name, test.query);
            results.push(odbcResult);
            console.log(`  ✓ ODBC completed: ${formatTime(odbcResult.duration)}, ${odbcResult.rows} rows`);
        } catch (error) {
            console.log(`  ✗ ODBC failed: ${error.message}`);
        }

        try {
            console.log('  Running Native Driver benchmark...');
            const nativeResult = await benchmarkNativeDriver(test.name, test.query);
            results.push(nativeResult);
            console.log(`  ✓ Native completed: ${formatTime(nativeResult.duration)}, ${nativeResult.rows} rows`);
        } catch (error) {
            console.log(`  ✗ Native Driver failed: ${error.message}`);
        }
    }

    printResults(results);
}

function printResults(results) {
    console.log('\n\n' + '='.repeat(80));
    console.log('BENCHMARK RESULTS');
    console.log('='.repeat(80) + '\n');

    const groupedResults = {};
    for (const result of results) {
        if (!groupedResults[result.query]) {
            groupedResults[result.query] = [];
        }
        groupedResults[result.query].push(result);
    }

    for (const [queryName, queryResults] of Object.entries(groupedResults)) {
        console.log(`\n${queryName}`);
        console.log('-'.repeat(80));

        if (queryResults.length < 2) {
            console.log('  Not enough data to compare (need both ODBC and Native)');
            for (const result of queryResults) {
                console.log(`  ${result.driver}: ${formatTime(result.duration)}, ${result.rows} rows, ${formatBytes(result.memoryUsed)} memory`);
            }
            continue;
        }

        const [odbcResult, nativeResult] = queryResults;

        console.log('  ┌─────────────────┬──────────────────┬──────────────────┬──────────────────┐');
        console.log('  │ Metric          │ ODBC             │ Native Driver    │ Difference       │');
        console.log('  ├─────────────────┼──────────────────┼──────────────────┼──────────────────┤');
        
        const timeDiff = ((nativeResult.duration - odbcResult.duration) / odbcResult.duration * 100).toFixed(1);
        const timeSymbol = timeDiff > 0 ? '+' : '';
        console.log(`  │ Time            │ ${formatTime(odbcResult.duration).padEnd(16)} │ ${formatTime(nativeResult.duration).padEnd(16)} │ ${timeSymbol}${timeDiff}%`.padEnd(82) + '│');
        
        const memDiff = ((nativeResult.memoryUsed - odbcResult.memoryUsed) / odbcResult.memoryUsed * 100).toFixed(1);
        const memSymbol = memDiff > 0 ? '+' : '';
        console.log(`  │ Memory Used     │ ${formatBytes(odbcResult.memoryUsed).padEnd(16)} │ ${formatBytes(nativeResult.memoryUsed).padEnd(16)} │ ${memSymbol}${memDiff}%`.padEnd(82) + '│');
        
        const rowsDiff = ((nativeResult.rowsPerSecond - odbcResult.rowsPerSecond) / odbcResult.rowsPerSecond * 100).toFixed(1);
        const rowsSymbol = rowsDiff > 0 ? '+' : '';
        console.log(`  │ Rows/Second     │ ${odbcResult.rowsPerSecond.toFixed(0).padEnd(16)} │ ${nativeResult.rowsPerSecond.toFixed(0).padEnd(16)} │ ${rowsSymbol}${rowsDiff}%`.padEnd(82) + '│');
        
        const throughputDiff = ((nativeResult.throughput - odbcResult.throughput) / odbcResult.throughput * 100).toFixed(1);
        const throughputSymbol = throughputDiff > 0 ? '+' : '';
        console.log(`  │ Throughput      │ ${formatBytes(odbcResult.throughput).padEnd(16)}/s │ ${formatBytes(nativeResult.throughput).padEnd(16)}/s │ ${throughputSymbol}${throughputDiff}%`.padEnd(82) + '│');
        
        console.log('  └─────────────────┴──────────────────┴──────────────────┴──────────────────┘');

        const winner = odbcResult.duration < nativeResult.duration ? 'ODBC' : 'Native Driver';
        console.log(`\n  🏆 Winner: ${winner} (${formatTime(Math.min(odbcResult.duration, nativeResult.duration))})`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));

    const odbcResults = results.filter(r => r.driver === 'ODBC');
    const nativeResults = results.filter(r => r.driver === 'Native');

    if (odbcResults.length > 0 && nativeResults.length > 0) {
        const odbcAvgTime = odbcResults.reduce((sum, r) => sum + r.duration, 0) / odbcResults.length;
        const nativeAvgTime = nativeResults.reduce((sum, r) => sum + r.duration, 0) / nativeResults.length;
        
        const odbcAvgMem = odbcResults.reduce((sum, r) => sum + r.memoryUsed, 0) / odbcResults.length;
        const nativeAvgMem = nativeResults.reduce((sum, r) => sum + r.memoryUsed, 0) / nativeResults.length;

        const odbcAvgRowsPerSec = odbcResults.reduce((sum, r) => sum + r.rowsPerSecond, 0) / odbcResults.length;
        const nativeAvgRowsPerSec = nativeResults.reduce((sum, r) => sum + r.rowsPerSecond, 0) / nativeResults.length;

        console.log(`\n  Average Execution Time:`);
        console.log(`    ODBC:           ${formatTime(odbcAvgTime)}`);
        console.log(`    Native Driver:  ${formatTime(nativeAvgTime)}`);
        console.log(`    Difference:     ${((nativeAvgTime - odbcAvgTime) / odbcAvgTime * 100).toFixed(1)}%`);

        console.log(`\n  Average Memory Usage:`);
        console.log(`    ODBC:           ${formatBytes(odbcAvgMem)}`);
        console.log(`    Native Driver:  ${formatBytes(nativeAvgMem)}`);
        console.log(`    Difference:     ${((nativeAvgMem - odbcAvgMem) / odbcAvgMem * 100).toFixed(1)}%`);

        console.log(`\n  Average Rows/Second:`);
        console.log(`    ODBC:           ${odbcAvgRowsPerSec.toFixed(0)}`);
        console.log(`    Native Driver:  ${nativeAvgRowsPerSec.toFixed(0)}`);
        console.log(`    Difference:     ${((nativeAvgRowsPerSec - odbcAvgRowsPerSec) / odbcAvgRowsPerSec * 100).toFixed(1)}%`);

        const overallWinner = odbcAvgTime < nativeAvgTime ? 'ODBC' : 'Native Driver';
        console.log(`\n  🏆 Overall Winner: ${overallWinner}`);
    }

    console.log('\n' + '='.repeat(80) + '\n');
}

if (require.main === module) {
    runBenchmark().catch(console.error);
} else {
    describe('BenchmarkODBCvsNative', () => {
        test.skip('manual performance benchmark', async () => {
            await runBenchmark();
        });
    });
}
