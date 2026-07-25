/**
 * Regression: orphaned SELECT CURRENT_SID response must not be attributed to a later CALL.
 * Reproduces the JustyBase VS Code flow (capture SID, then CALL) and the desync case
 * where an unread CURRENT_SID reply remains on the wire before the next command.
 */

const { NzConnection } = require('../dist/cjs/NzConnection');

const { getNzConfig } = require('./helpers/env');
const config = (() => { try { return getNzConfig(); } catch (e) { return null; } })();
const describeNz = config ? describe : describe.skip;


const PROC_NAME = 'JUST_DATA.ADMIN.JS_PROTOCOL_SYNC_TEST';
const CALL_SQL = `CALL ${PROC_NAME}();`;

function injectUnreadCurrentSid(conn) {
    const q = Buffer.from('SELECT CURRENT_SID', 'utf8');
    const buf = Buffer.allocUnsafe(1 + 4 + q.length + 1);
    buf[0] = 'P'.charCodeAt(0);
    buf.writeInt32BE(999999, 1);
    q.copy(buf, 5);
    buf[5 + q.length] = 0;
    conn._stream.write(buf);
}

async function readFirstResult(reader) {
    const columns = [];
    for (let i = 0; i < reader.fieldCount; i++) {
        columns.push(reader.getName(i));
    }
    let firstValue;
    let hasRow = false;
    if (await reader.read()) {
        hasRow = true;
        firstValue = reader.getValue(0);
    }
    while (await reader.nextResult()) {
        while (await reader.read()) {
            // drain extra result sets
        }
    }
    return { columns, hasRow, firstValue };
}

async function captureSid(conn) {
    const sidReader = await conn.createCommand('SELECT CURRENT_SID').executeReader();
    let sid;
    if (await sidReader.read()) {
        sid = sidReader.getValue(0);
    }
    await sidReader.close();
    return sid;
}

describeNz('Protocol sync - CURRENT_SID vs CALL', () => {
    let conn;

    beforeAll(async () => {
        conn = new NzConnection(config);
        await conn.connect();

        const createSql = `
            CREATE OR REPLACE PROCEDURE ${PROC_NAME}()
            RETURNS INTEGER
            EXECUTE AS OWNER
            LANGUAGE NZPLSQL
            AS BEGIN_PROC
            BEGIN
                RETURN NULL;
            END;
            END_PROC;
        `;
        await conn.createCommand(createSql).executeNonQuery();
    }, 60000);

    afterAll(async () => {
        if (!conn) return;
        try {
            await conn.createCommand(`DROP PROCEDURE ${PROC_NAME}`).executeNonQuery();
        } catch {
            // best-effort cleanup
        }
        await conn.close();
    });

    test('SELECT CURRENT_SID then CALL returns procedure columns, not CURRENT_SID', async () => {
        const sid = await captureSid(conn);
        expect(sid).toBeDefined();

        const reader = await conn.createCommand(CALL_SQL).executeReader();
        const result = await readFirstResult(reader);
        await reader.close();

        expect(result.columns.length).toBeGreaterThan(0);
        expect(result.columns.map((n) => String(n).toUpperCase())).not.toContain('CURRENT_SID');
        expect(result.columns.some((name) => /CURRENT_SID/i.test(String(name)))).toBe(false);
        expect(result.hasRow).toBe(true);
        expect(result.firstValue).toBeNull();
    }, 30000);

    test('orphaned CURRENT_SID response is drained before CALL (no false CURRENT_SID result)', async () => {
        injectUnreadCurrentSid(conn);
        await new Promise((resolve) => setTimeout(resolve, 200));

        const reader = await conn.createCommand(CALL_SQL).executeReader();
        const result = await readFirstResult(reader);
        await reader.close();

        expect(result.columns.length).toBeGreaterThan(0);
        expect(result.columns.map((n) => String(n).toUpperCase())).not.toContain('CURRENT_SID');
        expect(result.columns.some((name) => /CURRENT_SID/i.test(String(name)))).toBe(false);
        expect(result.hasRow).toBe(true);
        expect(result.firstValue).toBeNull();

        // Connection remains usable after recovery
        const sid = await captureSid(conn);
        expect(sid).toBeDefined();
    }, 30000);

    test('repeated SID then CALL stays stable', async () => {
        for (let i = 0; i < 10; i++) {
            await captureSid(conn);
            const reader = await conn.createCommand(CALL_SQL).executeReader();
            const result = await readFirstResult(reader);
            await reader.close();

            expect(result.columns.map((n) => String(n).toUpperCase())).not.toContain('CURRENT_SID');
            expect(result.columns.some((name) => /CURRENT_SID/i.test(String(name)))).toBe(false);
            expect(result.firstValue).toBeNull();
        }
    }, 60000);
});
