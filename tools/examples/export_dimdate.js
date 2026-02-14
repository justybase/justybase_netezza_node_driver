const { NzConnection } = require('./dist/NzConnection');
const path = require('path');
const fs = require('fs');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const OUTPUT_DIR = 'd:\\TMP';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'dimdate_export.dat');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    try { fs.mkdirSync(OUTPUT_DIR); } catch (e) { }
}

// Remove file if it already exists (External Table CREATE fails if file exists)
if (fs.existsSync(OUTPUT_FILE)) {
    fs.unlinkSync(OUTPUT_FILE);
}

async function main() {
    console.log('Connecting to Netezza...');
    const conn = new NzConnection(config);

    try {
        await conn.connect();
        console.log('Connected!');

        console.log(`Exporting DIMDATE to ${OUTPUT_FILE}...`);

        // REMOTESOURCE 'jdbc' enables streaming to client driver
        const sql = `CREATE EXTERNAL TABLE '${OUTPUT_FILE}' 
                     USING (REMOTESOURCE 'jdbc' DELIMITER '|' LOGDIR '${OUTPUT_DIR}') 
                     AS SELECT * FROM JUST_DATA..DIMDATE`;

        const cmd = conn.createCommand(sql);

        // Execute export
        await cmd.executeNonQuery();

        console.log('Export completed successfully!');

        // Verify file exists
        if (fs.existsSync(OUTPUT_FILE)) {
            const stats = fs.statSync(OUTPUT_FILE);
            console.log(`File created: ${OUTPUT_FILE}`);
            console.log(`Size: ${stats.size} bytes`);
        } else {
            console.error('Error: Output file was not created.');
        }

    } catch (err) {
        console.error('Export failed:', err);
    } finally {
        await conn.close();
        console.log('Connection closed.');
    }
}

main();
