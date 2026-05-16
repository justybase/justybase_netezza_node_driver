const { NzConnection } = require('../dist/NzConnection');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

describe('NoticeTests', () => {
    let connection;

    beforeAll(async () => {
        // Optional: Ensure procedure exists or clean up
    });

    afterAll(async () => {
        if (connection) {
            connection.close();
        }
    });

    test('BasicNoticeTests', async () => {
        connection = new NzConnection(config);
        await connection.connect();

        // Create the procedure
        // Note: Using a unique name to avoid conflicts if parallel tests run
        const procName = "JUST_DATA.ADMIN.CUSTOMER_DOTNET_JS";
        const sql = `CREATE OR REPLACE PROCEDURE ${procName}() RETURNS INTEGER EXECUTE AS OWNER LANGUAGE NZPLSQL AS BEGIN_PROC BEGIN RAISE NOTICE 'The customer name is alpha'; RAISE NOTICE 'The customer location is beta'; END; END_PROC;`;

        const createCmd = connection.createCommand(sql);
        await createCmd.executeNonQuery();

        const notices = [];
        connection.on('notice', (msg) => {
            notices.push(msg.message);
        });

        const callCmd = connection.createCommand(`CALL ${procName}();`);
        await callCmd.executeNonQuery();

        // Check event emitter path
        expect(notices.length).toBe(2);
        expect(notices[0]).toContain("The customer name is alpha");
        expect(notices[1]).toContain("The customer location is beta");
        
        // Check array property path
        expect(callCmd.notices.length).toBe(2);
        expect(callCmd.notices[0]).toContain("The customer name is alpha");
        expect(callCmd.notices[1]).toContain("The customer location is beta");
    }, 30000);
});
