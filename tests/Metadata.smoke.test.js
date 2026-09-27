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
});
