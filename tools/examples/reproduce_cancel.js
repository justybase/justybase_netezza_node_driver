const { NzConnection } = require('../../dist');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const HEAVY_SQL = `
        SELECT     
        F1.PRODUCTKEY    
        , COUNT(DISTINCT (F1.PRODUCTKEY / F2.PRODUCTKEY))    
        FROM     
        ( SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY LIMIT 30000) F1,    
        ( SELECT * FROM JUST_DATA..FACTPRODUCTINVENTORY LIMIT 30000) F2    
        GROUP BY 1    
        LIMIT 500    
`;

async function main() {
    const conn = new NzConnection(config);
    try {
        console.log('Connecting...');
        await conn.connect();

        console.log('Creating command with HEAVY_SQL...');
        const cmd = conn.createCommand(HEAVY_SQL);

        console.log('Executing query (Async)...');
        const start = Date.now();
        const executionPromise = cmd.executeReader();

        console.log('Waiting 3 seconds...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log(`Cancelling query at ${Date.now() - start}ms...`);
        await cmd.cancel();
        console.log('Cancel signal sent.');

        try {
            await executionPromise;
            console.error('ERROR: Query finished successfully but should have been cancelled!');
        } catch (e) {
            console.log("Caught expected error:", e.message);
        }

    } catch (err) {
        console.error('Unexpected setup error:', err);
    } finally {
        console.log('Closing connection...');
        await conn.close();
    }
}

main();
