/**
 * Offline reader benchmark over the C# reference driver's replay fixtures
 * (`dimdate` 3652x19, `fact200k` 200000x7), mirroring its ReplayReaderBench.
 * There is no database latency: this isolates client-side transport, parsing
 * and decoding cost. The replay server runs in a child process.
 *
 * Usage: npm run build && npm run bench:replay [-- --samples 15 --json out.json
 *        --fixture fact200k --scenario FullRead_GetValue]
 */

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { PerformanceObserver, performance } = require('perf_hooks');

const driverEntry = process.env.NZ_NODE_DRIVER_ENTRY || path.join(__dirname, '..', '..', 'dist', 'cjs');
const { NzConnection } = require(driverEntry);
const { loadFixture } = require('../../tests/helpers/replay/NzReplayFixture');

function parseArgs(argv) {
    const args = { samples: 10, warmup: 3, json: null, fixture: [], scenario: [] };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^--/, '');
        const value = argv[++i];
        if (key === 'fixture' || key === 'scenario') args[key].push(value);
        else if (key === 'json') args.json = value;
        else args[key] = Number(value);
    }
    return args;
}

const SCENARIOS = {
    async FullRead_GetValue(connection, sql) {
        const reader = await connection.createCommand(sql).executeReader();
        const fieldCount = reader.fieldCount;
        let rows = 0;
        while (await reader.read()) {
            for (let i = 0; i < fieldCount; i++) reader.getValue(i);
            rows++;
        }
        await reader.close();
        return rows;
    },
    async FullDecode_NoGetValue(connection, sql) {
        const reader = await connection.createCommand(sql).executeReader();
        let rows = 0;
        while (await reader.read()) rows++;
        await reader.close();
        return rows;
    },
    async FirstColumn(connection, sql) {
        const reader = await connection.createCommand(sql).executeReader();
        let rows = 0;
        while (await reader.read()) {
            reader.getValue(0);
            rows++;
        }
        await reader.close();
        return rows;
    },
    async Read1_Dispose(connection, sql) {
        const reader = await connection.createCommand(sql).executeReader();
        await reader.read();
        reader.getValue(0);
        await reader.close();
        return 1;
    },
    async Read10_Dispose(connection, sql) {
        const reader = await connection.createCommand(sql).executeReader();
        for (let i = 0; i < 10; i++) await reader.read();
        await reader.close();
        return 10;
    },
    async ForAwait_RowObjects(connection, sql) {
        const reader = await connection.createCommand(sql).executeReader();
        let rows = 0;
        for await (const row of reader) {
            if (row) rows++;
        }
        return rows;
    },
    async Query_RowObjects(connection, sql) {
        const result = await connection.query(sql);
        return result.rowCount;
    },
};

async function startServer(fixtureName) {
    const child = fork(path.join(__dirname, 'server_process.js'), [fixtureName], { stdio: 'inherit' });
    const port = await new Promise((resolve, reject) => {
        child.once('message', (message) => resolve(message.port));
        child.once('exit', (code) => reject(new Error(`replay server exited with ${code}`)));
    });
    return { child, port };
}

function percentile(sorted, p) {
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function measure(connection, sql, scenario, args) {
    const gc = { count: 0, ms: 0 };
    const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            gc.count++;
            gc.ms += entry.duration;
        }
    });
    for (let i = 0; i < args.warmup; i++) await scenario(connection, sql);

    const times = [];
    let cpuMs = 0;
    let rows = 0;
    observer.observe({ entryTypes: ['gc'] });
    for (let i = 0; i < args.samples; i++) {
        if (global.gc) global.gc();
        const cpu = process.cpuUsage();
        const start = performance.now();
        rows = await scenario(connection, sql);
        times.push(performance.now() - start);
        const used = process.cpuUsage(cpu);
        cpuMs += (used.user + used.system) / 1000;
    }
    // Let the observer flush entries queued during the last sample.
    await new Promise((resolve) => setImmediate(resolve));
    observer.disconnect();
    times.sort((a, b) => a - b);
    const median = percentile(times, 0.5);
    return {
        rows,
        medianMs: median,
        p95Ms: percentile(times, 0.95),
        minMs: times[0],
        cpuMs: cpuMs / args.samples,
        rowsPerSec: rows / (median / 1000),
        // Excludes the forced collection that precedes each sample.
        gcPerOp: (gc.count - (global.gc ? args.samples : 0)) / args.samples,
        gcMsPerOp: gc.ms / args.samples,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const fixtures = args.fixture.length ? args.fixture : ['dimdate', 'fact200k'];
    const scenarioNames = args.scenario.length ? args.scenario : Object.keys(SCENARIOS);
    const results = [];

    for (const fixtureName of fixtures) {
        const { query } = loadFixture(fixtureName);
        const { child, port } = await startServer(fixtureName);
        const connection = new NzConnection({
            host: '127.0.0.1',
            port,
            database: 'JUST_DATA',
            user: 'replay',
            password: 'replay',
            securityLevel: 'OnlyUnsecuredSession',
        });
        await connection.connect();
        try {
            for (const name of scenarioNames) {
                const result = await measure(connection, query, SCENARIOS[name], args);
                results.push({ fixture: fixtureName, scenario: name, ...result });
                console.log(
                    `${fixtureName.padEnd(9)} ${name.padEnd(22)} median ${result.medianMs.toFixed(2).padStart(8)} ms` +
                        `  p95 ${result.p95Ms.toFixed(2).padStart(8)} ms  cpu ${result.cpuMs.toFixed(2).padStart(8)} ms` +
                        `  ${(result.rowsPerSec / 1e6).toFixed(2).padStart(6)} M rows/s` +
                        `  gc ${result.gcPerOp.toFixed(1).padStart(5)}/op ${result.gcMsPerOp.toFixed(2).padStart(6)} ms/op`
                );
            }
        } finally {
            await connection.close();
            child.disconnect();
        }
    }

    if (args.json) {
        const report = {
            node: process.version,
            driver: driverEntry,
            samples: args.samples,
            warmup: args.warmup,
            exposeGc: Boolean(global.gc),
            results,
        };
        fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
