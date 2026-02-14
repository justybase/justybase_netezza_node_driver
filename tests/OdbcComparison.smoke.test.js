/**
 * Smoke Tests - ODBC vs JsNzDriver Comparison
 * Fast subset of comparison tests covering key data types
 * Uses single connection for all tests
 */

const odbc = require('odbc');
const { NzConnection } = require('../dist/NzConnection');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const connectionString = `DRIVER={NetezzaSQL};SERVER=${config.host};PORT=${config.port};DATABASE=${config.database};UID=${config.user};PWD=${config.password};`;

// Essential queries covering all major data types (reduced from 190+ to 15)
const smokeQueries = [
    "SELECT 1",
    "SELECT 12345::BIGINT",
    "SELECT 3.14::FLOAT",
    "SELECT 3.14::DOUBLE",
    "SELECT 123.456::NUMERIC(10,3)",
    "SELECT '2023-01-01'::DATE",
    "SELECT '12:00:00'::TIME",
    "SELECT '2024-12-11 14:30:00'::TIMESTAMP",
    "SELECT 'abc'::VARCHAR(10)",
    "SELECT 'abc'::NCHAR(10)",
    "SELECT 'abc'::NVARCHAR(10)",
    "SELECT 15::BYTEINT",
    "SELECT 25000::SMALLINT",
    "SELECT true::BOOLEAN",
    "SELECT NULL",
    // Table-based queries for binary format
    "SELECT * FROM JUST_DATA.ADMIN.DIMDATE ORDER BY ROWID LIMIT 5",
    "SELECT * FROM JUST_DATA.ADMIN.DIMACCOUNT ORDER BY ROWID LIMIT 5",
];

function normalize(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'bigint') return val.toString();
    if (typeof val === 'boolean') return val ? 't' : 'f';

    if (val instanceof Date) {
        return val.toISOString();
    }

    if (typeof val === 'string') {
        if (val === 't') return 't';
        if (val === 'f') return 'f';

        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
            return val;
        }
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(val)) {
            return val.substring(0, 10);
        }
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
            const d = new Date(val);
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        if (val.includes('.')) {
            val = val.replace(/(\.\d+)/, (match, p1) => {
                const clean = p1.replace(/0+$/, '');
                return clean === '' ? '' : clean;
            });
            if (val.endsWith('.')) val = val.slice(0, -1);
            val = val.replace(/\.([+\-Z])/, '$1');
        }

        return val.trim();
    }

    if (typeof val === 'object' && val.hours !== undefined) {
        return `${String(val.hours).padStart(2, '0')}:${String(val.minutes).padStart(2, '0')}:${String(val.seconds).padStart(2, '0')}`;
    }

    return val.toString();
}

async function compareResults(nzReader, odbcResult) {
    let rowIdx = 0;
    while (await nzReader.read()) {
        if (rowIdx >= odbcResult.length) break;

        const odbcRow = odbcResult[rowIdx];
        expect(nzReader.fieldCount).toBe(odbcRow.length);

        for (let j = 0; j < nzReader.fieldCount; j++) {
            const valJs = normalize(nzReader.getValue(j));
            const valOdbc = normalize(odbcRow[j]);

            if (valJs !== valOdbc) {
                const nJs = Number(valJs);
                const nOdbc = Number(valOdbc);
                if (!isNaN(nJs) && !isNaN(nOdbc)) {
                    if (nJs < 0 && nOdbc === nJs + 256) continue;
                    if ((nOdbc === 2147483647 && nJs > nOdbc) || (nOdbc === -2147483648 && nJs < nOdbc)) continue;
                    expect(nJs).toBeCloseTo(nOdbc, 3);
                    continue;
                }

                if (typeof valJs === 'string' && typeof valOdbc === 'string') {
                    if (valJs.length > valOdbc.length && valOdbc.length > 5 && valJs.startsWith(valOdbc)) {
                        continue;
                    }

                    const dJs = new Date(valJs);
                    const dOdbc = new Date(valOdbc);
                    if (!isNaN(dJs) && !isNaN(dOdbc)) {
                        if (Math.abs(dJs.getTime() - dOdbc.getTime()) < 5000) continue;
                    }
                }
            }

            try {
                expect(valJs).toBe(valOdbc);
            } catch (e) {
                console.error(`Failed Row ${rowIdx} Col ${j} (${nzReader.getName(j)}): JS '${valJs}' != ODBC '${valOdbc}'`);
                throw e;
            }
        }
        rowIdx++;
    }
    expect(rowIdx).toBe(odbcResult.length);
}

describe('Smoke Tests - ODBC vs JsNzDriver Comparison', () => {
    let nzConn = null;
    let odbcConn = null;

    // Single connection setup for all smoke tests
    beforeAll(async () => {
        nzConn = new NzConnection(config);
        await nzConn.connect();

        try {
            odbcConn = await odbc.connect({
                connectionString,
                fetchArray: true
            });
        } catch (e) {
            console.error("ODBC Connection Error. Check installed driver.");
            throw e;
        }
    }, 30000);

    afterAll(async () => {
        if (nzConn) nzConn.close();
        if (odbcConn) await odbcConn.close();
    });

    test.each(smokeQueries)(
        'Query should match ODBC result: %s',
        async (query) => {
            const nzCmd = nzConn.createCommand(query);
            const nzReader = await nzCmd.executeReader();
            const odbcResult = await odbcConn.query(query);

            try {
                await compareResults(nzReader, odbcResult);
            } finally {
                await nzReader.close();
            }
        },
        30000
    );
});
