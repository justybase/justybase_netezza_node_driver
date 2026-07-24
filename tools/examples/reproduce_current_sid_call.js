#!/usr/bin/env node
/**
 * Stress-repro: mimic JustyBase VS Code flow
 *   SELECT CURRENT_SID  ->  CALL <proc>()
 * and detect when CALL returns CURRENT_SID columns (protocol desync).
 *
 * Usage:
 *   node tools/examples/reproduce_current_sid_call.js
 *   node tools/examples/reproduce_current_sid_call.js "CALL JUST_DATA.ADMIN.CUSTOMER_DOTNET();"
 *   node tools/examples/reproduce_current_sid_call.js --desync
 *
 * Env: NZ_DEV_HOST, NZ_DEV_USER, NZ_DEV_PASSWORD, NZ_DEV_DATABASE, NZ_DEV_PORT, NZ_CALL_SQL, NZ_ITERS
 *      NZ_DESYNC=1  — inject unread SELECT CURRENT_SID response before CALL (proves the bug)
 */
const path = require('path');
const { NzConnection } = require(path.join(__dirname, '../../dist/NzConnection'));

const config = {
    host: process.env.NZ_DEV_HOST || '192.168.0.144',
    port: parseInt(process.env.NZ_DEV_PORT || '5480', 10),
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password',
};

const args = process.argv.slice(2).filter((a) => a !== '--desync');
const desyncMode = process.argv.includes('--desync') || process.env.NZ_DESYNC === '1';
const callSql =
    args[0] ||
    process.env.NZ_CALL_SQL ||
    'CALL JUST_DATA.ADMIN.CUSTOMER_DOTNET();';
const iters = desyncMode ? 1 : parseInt(process.env.NZ_ITERS || '50', 10);
const concurrentProbe = process.env.NZ_CONCURRENT_PROBE === '1';

async function readAll(reader) {
    const columns = [];
    for (let i = 0; i < reader.fieldCount; i++) {
        columns.push(reader.getName(i));
    }
    const rows = [];
    while (await reader.read()) {
        const row = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            row.push(reader.getValue(i));
        }
        rows.push(row);
    }
    const more = [];
    while (await reader.nextResult()) {
        const cols2 = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            cols2.push(reader.getName(i));
        }
        const rows2 = [];
        while (await reader.read()) {
            const row = [];
            for (let i = 0; i < reader.fieldCount; i++) {
                row.push(reader.getValue(i));
            }
            rows2.push(row);
        }
        more.push({ columns: cols2, rows: rows2 });
    }
    return { columns, rows, more };
}

async function captureSid(conn) {
    const sidCmd = conn.createCommand('SELECT CURRENT_SID');
    const sidReader = await sidCmd.executeReader();
    let sid;
    if (await sidReader.read()) {
        sid = sidReader.getValue(0);
    }
    await sidReader.close();
    return sid;
}

/** Leave a full SELECT CURRENT_SID response unread on the wire (extension cancel/timeout class bug). */
function injectUnreadCurrentSid(conn) {
    const q = Buffer.from('SELECT CURRENT_SID', 'utf8');
    const buf = Buffer.allocUnsafe(1 + 4 + q.length + 1);
    buf[0] = 'P'.charCodeAt(0);
    buf.writeInt32BE(999999, 1);
    q.copy(buf, 5);
    buf[5 + q.length] = 0;
    conn._stream.write(buf);
}

async function main() {
    console.log('Connecting...', config.host, config.database);
    console.log('CALL SQL:', callSql);
    console.log('Iterations:', iters, 'concurrentProbe:', concurrentProbe, 'desyncMode:', desyncMode);

    const conn = new NzConnection(config);
    await conn.connect();

    let bugs = 0;
    for (let i = 1; i <= iters; i++) {
        if (!desyncMode) {
            await captureSid(conn);
        } else {
            console.log('Injecting unread SELECT CURRENT_SID response...');
            injectUnreadCurrentSid(conn);
            await new Promise((r) => setTimeout(r, 200));
        }

        let probePromise;
        if (concurrentProbe) {
            probePromise = (async () => {
                try {
                    await captureSid(conn);
                } catch {
                    /* busy expected */
                }
            })();
        }

        const cmd = conn.createCommand(callSql);
        let result;
        try {
            const reader = await cmd.executeReader();
            result = await readAll(reader);
            await reader.close();
        } catch (e) {
            console.log(`[${i}] CALL error:`, e.message);
            if (probePromise) await probePromise;
            continue;
        }
        if (probePromise) await probePromise;

        const names = result.columns || [];
        const mismatch = names.some((n) => /CURRENT_SID/i.test(String(n)));
        if (mismatch) {
            bugs++;
            console.log('!!! MISMATCH on iter', i, {
                columns: names,
                firstRow: result.rows[0],
                moreSets: result.more.length,
            });
        } else if (i % 10 === 0 || i === 1 || desyncMode) {
            console.log(`[${i}] ok cols=${JSON.stringify(names)} rows=${result.rows.length}`);
        }
    }

    await conn.close();
    console.log('Done. mismatches:', bugs);
    process.exit(bugs > 0 ? 2 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
