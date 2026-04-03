/**
 * Simple test - SELECT 1 (no table, should work with text format)
 */

const { NzConnection } = require('../../dist');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

async function main() {
    const conn = new NzConnection(config);

    try {
        console.log('Connecting to Netezza...');
        await conn.connect();
        console.log('Connected!\n');

        // Simple query without FROM - uses text format
        const sql = 'SELECT 1';
        console.log(`Executing: ${sql}\n`);

        const cmd = conn.createCommand(sql);
        const reader = await cmd.executeReader();

        if (await reader.read()) {
            console.log('Result:', reader.getValue(0));
        }
        await reader.close();

        // Create External Table Export (commented out to keep test fast)
        // const exportSql = "CREATE EXTERNAL TABLE 'D:\\DEV\\source\\repos\\PublicNuget\\JsNzDriver\\scJs\\res.txt' USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR 'D:\\\\TMP') AS SELECT now(),* FROM JUST_DATA.ADMIN.DIMDATE";
        // console.log(`\nExecuting Export: ${exportSql}\n`);
        // const exportCmd = conn.createCommand(exportSql);
        // await exportCmd.executeNonQuery();
        // console.log('Export completed.');

        // --- DEMO: RAISE NOTICE ---
        console.log('\n--- DEMO: RAISE NOTICE ---');
        conn.on('notice', (msg) => console.log('Notice Received:', msg.message));

        await conn.createCommand(`
            CREATE OR REPLACE PROCEDURE JSNZ_NOTICE_DEMO() RETURNS INT LANGUAGE NZPLSQL AS 
            BEGIN_PROC BEGIN RAISE NOTICE 'Hello from Netezza Procedure!'; END; END_PROC;
        `).executeNonQuery();

        await conn.createCommand("CALL JSNZ_NOTICE_DEMO()").executeNonQuery();


        // --- DEMO: getSchemaTable ---
        console.log('\n--- DEMO: getSchemaTable ---');
        const schemaCmd = conn.createCommand("SELECT 'test'::VARCHAR(50) as STR_COL, 123::INT as AB_COL, now() as TIME_COL");
        const schemaReader = await schemaCmd.executeReader();
        const schema = schemaReader.getSchemaTable();

        console.log('Columns found:', schema.Rows.length);
        schema.Rows.forEach(row => {
            console.log(`- Name: ${row.ColumnName}, Type: ${row.DataType.name}, Size: ${row.ColumnSize}, Precision: ${row.NumericPrecision}`);
        });
        await schemaReader.close();


        // --- DEMO: Invalid Results (Error Handling) ---
        console.log('\n--- DEMO: Invalid SQL Handling ---');
        try {
            console.log("Executing invalid SQL: SELECT 1/0");
            await conn.createCommand("SELECT 1/0").executeReader();
        } catch (e) {
            console.log("Caught expected error:", e.message);
        }

        // --- DEMO: Invalid Cast (Text to Int) ---
        console.log('\n--- DEMO: Invalid Cast Handling ---');
        try {
            const tableName = "TEST_NUM_TXT";
            // Check cleanup
            await conn.createCommand(`DROP TABLE ${tableName} IF EXISTS`).executeNonQuery();
            // Create table with text value
            await conn.createCommand(`CREATE TABLE ${tableName} AS SELECT 'X' AS COL DISTRIBUTE ON RANDOM`).executeNonQuery();

            console.log(`Executing invalid cast: SELECT COL::INT FROM ${tableName}`);
            const cmd = conn.createCommand(`SELECT COL::INT FROM ${tableName}`);
            const r = await cmd.executeReader();
            // Consume to ensure error is triggered if it happens during streaming
            while (await r.read()) { }
            await r.close();

        } catch (e) {
            console.log("Caught expected error:", e.message);
        } finally {
            // Cleanup
            try {
                await conn.createCommand("DROP TABLE TEST_NUM_TXT IF EXISTS").executeNonQuery();
            } catch (e) { }
        }


        // --- DEMO: Timestamp Literal Parsing ---
        console.log('\n--- DEMO: Timestamp Literal Parsing ---');
        
        const timestampQueries = [
            "SELECT '2023-03-26 01:30:00'::timestamp FROM JUST_DATA..DIMACCOUNT LIMIT 1",
            //"SELECT '2023-03-26 01:30:00'::timestamp",
            "SELECT '2023-03-31 12:30:00'::timestamp FROM JUST_DATA..DIMACCOUNT LIMIT 1",
            //"SELECT '2023-03-31 12:30:00'::timestamp",
            "SELECT '2023-03-01 12:30:00'::timestamp FROM JUST_DATA..DIMACCOUNT LIMIT 1",
            //"SELECT '2023-03-01 12:30:00'::timestamp",
            //"SELECT '2023-03-01'::DATE",
            "SELECT '2023-03-01'::DATE FROM JUST_DATA..DIMACCOUNT LIMIT 1",
            "SELECT '2023-03-31'::DATE FROM JUST_DATA..DIMACCOUNT LIMIT 1"
        ];

        for (const sql of timestampQueries) {
            console.log(`Executing: ${sql}`);
            try {
                const cmd = conn.createCommand(sql);
                const reader = await cmd.executeReader();
                if (await reader.read()) {
                    const readerValue = reader.getValue(0);

                    if (readerValue instanceof  Date) {
                        const y = readerValue.getFullYear();       //local
                        const m = String(readerValue.getMonth() + 1).padStart(2, '0');  // local
                        const d = String(readerValue.getDate()).padStart(2, '0');       // local
                        const hh = String(readerValue.getHours()).padStart(2, '0');   // local
                        const mm = String(readerValue.getMinutes()).padStart(2, '0'); // local
                        const ss = String(readerValue.getSeconds()).padStart(2, '0'); // local
                        console.log(' ISO  :', readerValue.toISOString());
                        console.log(` Local: ${y}-${m}-${d} ${hh}:${mm}:${ss}`);
                    }
                    else{
                        console.log(typeof readerValue)
                    }
                    console.log(' Result   :', readerValue);
                    console.log(' localiced:', readerValue.toString());
                    console.log('\n');
                }
                await reader.close();
            } catch (e) {
                console.log('  Error:', e.message);
            }
        }

        console.log('SUCCESS!');
    } catch (err) {
        console.error('Error:', err.message);
        console.error(err.stack);
    } finally {
        conn.close();
        console.log('\nConnection closed.');
    }
}

main();
