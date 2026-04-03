/**
 * Multiple Result Sets Demo
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

        const sql = "SELECT 1,* FROM JUST_DATA..DIMDATE LIMIT 2;SELECT 123;SELECT 2,* FROM JUST_DATA..DIMACCOUNT LIMIT 2";
        console.log(`Executing: ${sql}\n`);

        const cmd = conn.createCommand(sql);
        const reader = await cmd.executeReader();

        let resultSetCount = 0;

        do {
            resultSetCount++;
            console.log(`\n--- Result Set #${resultSetCount} ---`);

            // Print Columns
            const columns = reader.columnDescriptions || [];
            if (columns.length > 0) {
                console.log('Columns:', columns.map(c => c.name).join(', '));
            }

            let rowCount = 0;
            while (await reader.read()) {
                rowCount++;

                // Get all values for the row
                const rowValues = [];
                for (let i = 0; i < (columns.length || 1); i++) {
                    // Check if columns exist, otherwise try to read index 0?
                    // Actually columnDescriptions should be populated if rows are there.
                    // But for 'SELECT 123', is there a column desc? Yes, '?COLUMN?'

                    if (columns.length > 0) {
                        rowValues.push(String(reader.getValue(i)));
                    } else {
                        // Fallback if no schema but has rows (rare/impossible in Netezza?)
                        rowValues.push(String(reader.getValue(0)));
                    }
                }
                console.log(`Row ${rowCount}: ${rowValues.join(', ')}`);
            }
            console.log(`(End of Result Set #${resultSetCount})`);


        } while (await reader.nextResult());


        const sql2 = "SELECT 1,* FROM JUST_DATA..DIMDATE LIMIT 2";
        console.log(`Executing: ${sql}\n`);

        const cmd2 = conn.createCommand(sql2);
        const reader2 = await cmd2.executeReader();

        while (await reader2.read()) {
            console.log(reader2.getValue(0));
            console.log(reader2.getValue(1));
        }


        console.log('\nSUCCESS! Processed all result sets.');

    } catch (err) {
        console.error('Error:', err.message);
        console.error(err.stack);
    } finally {
        conn.close();
        console.log('\nConnection closed.');
    }
}

main();
