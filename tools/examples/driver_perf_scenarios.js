const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { NzConnection } = require('../../dist');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const ROW_LIMIT = Number(process.env.NZ_BENCH_ROWS || 50000);
const TEXT_REPETITIONS = Number(process.env.NZ_BENCH_TEXT_REPETITIONS || 1500);
const SAMPLE_COUNT = Number(process.env.NZ_BENCH_SAMPLES || 3);
const OUTPUT_PATH = process.argv[2] || null;

const SCENARIOS = [
    {
        name: 'text-typed-loose',
        description: 'Repeated typed text-protocol scalar query without FROM',
        query: `
            SELECT
                true::BOOLEAN AS ok,
                1234567890123456789::BIGINT AS big_id,
                123.456::NUMERIC(10,3) AS amount,
                3.1400::NUMERIC(10,4) AS exact_amount,
                '2024-12-11'::DATE AS d,
                '2024-12-11 14:30:00'::TIMESTAMP AS ts,
                '05:41:15'::TIME AS t,
                'alpha'::VARCHAR(10) AS label
        `,
        repetitions: TEXT_REPETITIONS,
    },
    {
        name: 'binary-fixed-width',
        description: 'Fixed-width binary row parsing from a large fact table',
        query: `
            SELECT
                1::INT AS a,
                2::INT AS b,
                3::INT AS c,
                4::INT AS d,
                '2024-12-11'::DATE AS dte,
                '2024-12-11 14:30:00'::TIMESTAMP AS ts
            FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY
            ORDER BY ROWID
            LIMIT ${ROW_LIMIT}
        `,
        repetitions: 1,
    },
    {
        name: 'binary-variable-width',
        description: 'Variable-width character decoding from a large fact table',
        query: `
            SELECT
                'ALPHA'::VARCHAR(20) AS vc1,
                'BETA GAMMA'::VARCHAR(20) AS vc2,
                'delta'::NVARCHAR(20) AS nvc,
                'epsilon'::NCHAR(10) AS nc,
                'zeta'::VARCHAR(40) AS vc3
            FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY
            ORDER BY ROWID
            LIMIT ${ROW_LIMIT}
        `,
        repetitions: 1,
    },
    {
        name: 'binary-numeric-heavy',
        description: 'Binary NUMERIC conversion with precision-preserving outputs',
        query: `
            SELECT
                12345678901234567890.123456::NUMERIC(30,6) AS n1,
                999999999999999999.999999::NUMERIC(30,6) AS n2,
                3.1400::NUMERIC(10,4) AS n3,
                42.42::NUMERIC(18,2) AS n4
            FROM JUST_DATA.ADMIN.FACTPRODUCTINVENTORY
            ORDER BY ROWID
            LIMIT ${ROW_LIMIT}
        `,
        repetitions: 1,
    },
];

async function consumeReader(reader) {
    let rows = 0;
    let cells = 0;

    while (await reader.read()) {
        rows++;
        const fieldCount = reader.fieldCount;
        cells += fieldCount;
        for (let i = 0; i < fieldCount; i++) {
            reader.getValue(i);
        }
    }

    await reader.close();
    return { rows, cells };
}

async function runScenario(connection, scenario) {
    const samples = [];

    for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex++) {
        const startHeap = process.memoryUsage().heapUsed;
        const start = performance.now();
        let rows = 0;
        let cells = 0;

        for (let repetition = 0; repetition < scenario.repetitions; repetition++) {
            const reader = await connection.createCommand(scenario.query).executeReader();
            const result = await consumeReader(reader);
            rows += result.rows;
            cells += result.cells;
        }

        const elapsedMs = performance.now() - start;
        const endHeap = process.memoryUsage().heapUsed;
        samples.push({
            elapsedMs,
            rows,
            cells,
            heapDelta: endHeap - startHeap,
        });
    }

    const totalMs = samples.reduce((sum, sample) => sum + sample.elapsedMs, 0);
    const totalRows = samples.reduce((sum, sample) => sum + sample.rows, 0);
    const totalCells = samples.reduce((sum, sample) => sum + sample.cells, 0);
    const totalHeapDelta = samples.reduce((sum, sample) => sum + sample.heapDelta, 0);

    return {
        name: scenario.name,
        description: scenario.description,
        repetitionsPerSample: scenario.repetitions,
        samples,
        averageMs: totalMs / samples.length,
        minMs: Math.min(...samples.map((sample) => sample.elapsedMs)),
        maxMs: Math.max(...samples.map((sample) => sample.elapsedMs)),
        averageRows: totalRows / samples.length,
        averageCells: totalCells / samples.length,
        averageHeapDelta: totalHeapDelta / samples.length,
        rowsPerSecond: totalRows / (totalMs / 1000),
        cellsPerSecond: totalCells / (totalMs / 1000),
    };
}

function printScenario(result) {
    console.log(`\n[${result.name}] ${result.description}`);
    console.log(`  avg: ${result.averageMs.toFixed(2)} ms`);
    console.log(`  min/max: ${result.minMs.toFixed(2)} / ${result.maxMs.toFixed(2)} ms`);
    console.log(`  rows/sample: ${result.averageRows.toFixed(0)}`);
    console.log(`  rows/sec: ${result.rowsPerSecond.toFixed(0)}`);
    console.log(`  cells/sec: ${result.cellsPerSecond.toFixed(0)}`);
    console.log(`  avg heap delta: ${result.averageHeapDelta.toFixed(0)} bytes`);
}

async function main() {
    const connection = new NzConnection(config);
    await connection.connect();

    try {
        const results = [];

        for (const scenario of SCENARIOS) {
            const warmupReader = await connection.createCommand(scenario.query).executeReader();
            await consumeReader(warmupReader);

            const result = await runScenario(connection, scenario);
            results.push(result);
            printScenario(result);
        }

        const output = {
            generatedAt: new Date().toISOString(),
            host: config.host,
            database: config.database,
            rowLimit: ROW_LIMIT,
            textRepetitions: TEXT_REPETITIONS,
            sampleCount: SAMPLE_COUNT,
            results,
        };

        if (OUTPUT_PATH) {
            fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
            fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
            console.log(`\nSaved benchmark results to ${OUTPUT_PATH}`);
        } else {
            console.log(`\n${JSON.stringify(output, null, 2)}`);
        }
    } finally {
        await connection.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});