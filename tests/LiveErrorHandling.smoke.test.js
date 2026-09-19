const { NzConnection } = require('../dist/cjs/NzConnection');
const { NzDatabaseError } = require('../dist/cjs/errors/NzDatabaseError');
const { getNzConfig } = require('./helpers/env');

const config = (() => {
    try {
        return getNzConfig();
    } catch (_error) {
        return null;
    }
})();
const describeNz = config ? describe : describe.skip;

describeNz('live error handling', () => {
    test('preserves a legacy SQL error and reuses the session', async () => {
        const connection = new NzConnection(config);
        await connection.connect();

        try {
            await expect(connection.query('SELEC 1')).rejects.toBeInstanceOf(NzDatabaseError);
            await expect(connection.query('SELECT 2 AS two')).resolves.toMatchObject({
                rows: [{ TWO: 2 }],
            });
        } finally {
            await connection.close();
        }
    }, 30_000);

    test('surfaces a second-result error without poisoning the session', async () => {
        const connection = new NzConnection(config);
        await connection.connect();

        try {
            const missing = `__codex_missing_table_${Date.now()}`;
            const reader = await connection
                .createCommand(`SELECT 11 AS v1; SELECT * FROM "${missing}"`)
                .executeReader();

            expect(await reader.read()).toBe(true);
            expect(reader.getValue(0)).toBe(11);
            expect(await reader.read()).toBe(false);
            await expect(reader.nextResult()).rejects.toBeInstanceOf(NzDatabaseError);
            await reader.close();

            await expect(connection.query('SELECT 22 AS after_reader')).resolves.toMatchObject({
                rows: [{ AFTER_READER: 22 }],
            });
        } finally {
            await connection.close();
        }
    }, 30_000);

    test('returns a database error for the observed empty handshake response', async () => {
        const connection = new NzConnection({
            ...config,
            database: `__codex_missing_database_${Date.now()}`,
        });

        await expect(connection.connect()).rejects.toMatchObject({
            name: 'NzDatabaseError',
            message: 'Netezza backend returned an empty error response',
        });
        await connection.close();
    }, 30_000);
});
