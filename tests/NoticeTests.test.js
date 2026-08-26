const { NzConnection } = require('../dist/cjs/NzConnection');

const { getNzConfig } = require('./helpers/env');
const config = (() => { try { return getNzConfig(); } catch (e) { return null; } })();
const describeNz = config ? describe : describe.skip;


describeNz('NoticeTests', () => {
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

        // Use a unique object and always remove it. This test must not overwrite
        // a developer-owned procedure on a shared appliance.
        const procName = `JUST_DATA.ADMIN.CUSTOMER_DOTNET_JS_${process.pid}_${Date.now()}`;
        try {
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
        } finally {
            await connection.createCommand(`DROP PROCEDURE ${procName}`).executeNonQuery().catch(() => {});
        }
    }, 30000);
});
