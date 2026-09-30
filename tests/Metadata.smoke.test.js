const { NzConnection } = require('../dist/cjs/NzConnection');
const { getNzConfig } = require('./helpers/env');

const config = (() => { try { return getNzConfig(); } catch { return null; } })();
const describeNz = config ? describe : describe.skip;

describeNz('Metadata helpers against Netezza', () => {
    let connection;
    beforeAll(async () => {
        connection = new NzConnection(config);
        await connection.connect();
    });
    afterAll(async () => {
        if (connection) await connection.close();
    });

    test('returns detailed columns and reconstructs table DDL', async () => {
        const database = await connection.meta.getCurrentDatabase();
        expect(database).toBeTruthy();
        const columns = await connection.meta.getDetailedColumns('DIMDATE', 'ADMIN');
        expect(columns.length).toBeGreaterThan(0);
        const ddl = await connection.meta.getTableDdl('DIMDATE', 'ADMIN');
        expect(ddl).toContain('CREATE TABLE');
        expect(ddl).toContain('DIMDATE');
        const batch = await connection.meta.getTablesDdl('ADMIN', undefined, ['DIMDATE']);
        expect(batch).toHaveLength(1);
        expect(batch[0].error).toBeNull();
        expect(await connection.meta.getFunctions('ADMIN')).toBeDefined();
        expect(await connection.meta.getSynonyms('ADMIN')).toBeDefined();
        expect(await connection.meta.getConstraints('ADMIN')).toBeDefined();
        expect(await connection.meta.getAllDistributionKeys('ADMIN')).toBeDefined();
        expect(await connection.meta.getOrganizeKeys('ADMIN')).toBeDefined();
        expect(await connection.meta.getObjectDetails('ADMIN')).toBeDefined();
        expect((await connection.meta.searchObjects('DIMDATE', 'ADMIN')).length).toBeGreaterThan(0);
        expect((await connection.meta.searchObjectsDetailed('DIMDATE', 'ADMIN')).length).toBeGreaterThan(0);
    });

    test('recreates all catalog DDL object kinds', async () => {
        const suffix = Math.random().toString(36).slice(2, 10).toUpperCase();
        const table = 'JB_DDL_T_' + suffix;
        const view = 'JB_DDL_V_' + suffix;
        const procedure = 'JB_DDL_P_' + suffix;
        const synonym = 'JB_DDL_S_' + suffix;
        const external = 'JB_DDL_E_' + suffix;
        const cleanup = async () => {
            for (const sql of [
                `DROP VIEW ADMIN.${view}`, `DROP PROCEDURE ADMIN.${procedure}()`, `DROP SYNONYM ADMIN.${synonym}`,
                `DROP TABLE ADMIN.${external}`, `DROP TABLE ADMIN.${table}`,
            ]) {
                try { await connection.query(sql); } catch { /* object may not exist */ }
            }
        };
        await cleanup();
        try {
            await connection.query(`CREATE TABLE ADMIN.${table}("SELECT" INTEGER) DISTRIBUTE ON ("SELECT")`);
            await connection.query(`CREATE VIEW ADMIN.${view} AS SELECT "SELECT" FROM ADMIN.${table}`);
            await connection.query(`COMMENT ON VIEW ADMIN.${view} IS 'DDL round-trip view comment'`);
            await connection.query(`COMMENT ON COLUMN ADMIN.${view}."SELECT" IS 'DDL round-trip view column comment'`);
            await connection.query(`CREATE OR REPLACE PROCEDURE ADMIN.${procedure}() RETURNS INTEGER EXECUTE AS OWNER LANGUAGE NZPLSQL AS BEGIN_PROC BEGIN RETURN 1; END; END_PROC;`);
            await connection.query(`COMMENT ON PROCEDURE ADMIN.${procedure}() IS 'DDL round-trip comment'`);
            await connection.query(`CREATE SYNONYM ADMIN.${synonym} FOR ADMIN.${table}`);
            await connection.query(`COMMENT ON SYNONYM ADMIN.${synonym} IS 'DDL round-trip comment'`);
            await connection.query(`CREATE EXTERNAL TABLE ADMIN.${external}(ID INTEGER, LABEL CHAR(10), EVENT_DATE DATE) USING (DATAOBJECT('/tmp/${external}.csv') FORMAT 'FIXED' RECORDLENGTH 24 RECORDDELIM '\r\n' LAYOUT (BYTES 4, BYTES 10, DATE YMD ' ' BYTES 10))`);

            const metadata = connection.meta;
            const viewDdl = await metadata.getViewDdl(view, 'ADMIN');
            const qualifiedView = `${await metadata.getCurrentDatabase()}.ADMIN.${view}`;
            expect(viewDdl).toContain(`COMMENT ON VIEW ${qualifiedView} IS 'DDL round-trip view comment';`);
            expect(viewDdl).toContain(`COMMENT ON COLUMN ${qualifiedView}."SELECT" IS 'DDL round-trip view column comment';`);
            const viewBatch = await metadata.getViewsDdl('ADMIN', undefined, [view]);
            expect(viewBatch).toHaveLength(1);
            expect(viewBatch[0].ddl).toContain('DDL round-trip view comment');
            expect(viewBatch[0].ddl).toContain('DDL round-trip view column comment');
            const ddls = [
                await metadata.getTableDdl(table, 'ADMIN'),
                viewDdl,
                await metadata.getProcedureDdl(procedure, 'ADMIN'),
                await metadata.getSynonymDdl(synonym, 'ADMIN'),
                await metadata.getExternalTableDdl(external, 'ADMIN'),
            ];
            await cleanup();
            for (const ddl of ddls) await connection.query(ddl);
        } finally {
            await cleanup();
        }
    });
});
