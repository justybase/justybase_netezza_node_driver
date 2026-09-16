const { NzConnection } = require('../dist/cjs/NzConnection');
const { getNzConfig } = require('./helpers/env');
const { isDotnetAvailable, runBatch, assertReferenceEqual, readNodeResult } = require('./helpers/csharpReference');

const config = (() => {
    try {
        return getNzConfig();
    } catch {
        return null;
    }
})();

const describeReference = config && isDotnetAvailable() ? describe : describe.skip;

const smokeQueries = [
    'SELECT 1',
    "SELECT 'abc'::VARCHAR(10)",
    "SELECT 'abc'::NCHAR(10)",
    "SELECT 'Zażółć'::NVARCHAR(100)",
    'SELECT 15::BYTEINT',
    'SELECT 25000::SMALLINT',
    'SELECT 9223372036854775807::BIGINT',
    'SELECT 3.14::DOUBLE',
    'SELECT 123.456::NUMERIC(10,3)',
    "SELECT '2024-01-02'::DATE",
    "SELECT '12:34:56'::TIME",
    "SELECT '2024-01-02 12:34:56'::TIMESTAMP",
    'SELECT true::BOOLEAN',
    'SELECT NULL',
    'SELECT * FROM JUST_DATA.ADMIN.DIMDATE ORDER BY ROWID LIMIT 5',
    'SELECT * FROM JUST_DATA.ADMIN.DIMACCOUNT ORDER BY ROWID LIMIT 5',
];

describeReference('C# JustyBase.NetezzaDriver vs Node compatibility smoke tests', () => {
    let connection;
    let referenceByQuery;

    beforeAll(async () => {
        connection = new NzConnection(config);
        await connection.connect();
        // One C# process/connection for all smoke queries.
        const results = runBatch(smokeQueries);
        referenceByQuery = new Map(smokeQueries.map((query, index) => [query, results[index]]));
    }, 300000);

    afterAll(async () => {
        if (connection) await connection.close();
    });

    test.each(smokeQueries)('matches C# reference: %s', async (query) => {
        const nodeResult = await readNodeResult(connection, query);
        assertReferenceEqual(nodeResult, referenceByQuery.get(query), query);
    }, 120000);
});
