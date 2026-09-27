const {
    buildTableDdl,
    buildViewDdl,
    buildProcedureDdl,
    buildExternalTableDdl,
    buildSynonymDdl,
} = require('../dist/cjs/metadata/ddl');
const { normalizeObjectName } = require('../dist/cjs/metadata/NzMetadata');

describe('metadata DDL reconstruction', () => {
    test('quotes qualified object names and preserves procedure signatures', () => {
        expect(normalizeObjectName('ADMIN."Mixed.Name"')).toEqual({ schema: 'ADMIN', name: 'Mixed.Name' });
        expect(normalizeObjectName('ADMIN.PROC(NUMERIC(10,2))')).toEqual({
            schema: 'ADMIN',
            name: 'PROC(NUMERIC(10,2))',
        });
    });

    test('formats all five supported object types', () => {
        const table = buildTableDdl(
            'DB', 'ADMIN', 'T', [
                { name: 'ID', typeName: 'INTEGER', notNull: true, defaultValue: null, description: null },
            ],
            ['ID'], [], [], null
        );
        expect(table).toContain('CREATE TABLE DB.ADMIN.T');
        expect(table).toContain('DISTRIBUTE ON (ID)');

        expect(buildViewDdl('DB', 'ADMIN', 'V', 'SELECT ID FROM T;'))
            .toBe('CREATE OR REPLACE VIEW DB.ADMIN.V AS\nSELECT ID FROM T;');

        const procedure = buildProcedureDdl('DB', 'ADMIN', {
            name: 'P', arguments: 'x INTEGER', returns: 'INTEGER',
            executedAsOwner: true, description: "owner's procedure",
            source: 'BEGIN RETURN 1; END;',
        });
        expect(procedure).toContain('CREATE OR REPLACE PROCEDURE DB.ADMIN.P(x INTEGER)');
        expect(procedure).toContain("owner''s procedure");

        const external = buildExternalTableDdl(
            'DB', 'ADMIN', 'E', '/tmp/data.txt',
            [{ name: 'ID', typeName: 'INTEGER', notNull: false }],
            new Map([['remotesource', 'jdbc'], ['maxerrors', 10]])
        );
        expect(external).toContain("DATAOBJECT('/tmp/data.txt')");
        expect(external).toContain("REMOTESOURCE 'jdbc'");
        expect(external).toContain('MAXERRORS 10');

        expect(buildSynonymDdl('DB', 'ADMIN', 'S', 'DB.ADMIN.T', null))
            .toBe('CREATE SYNONYM DB.ADMIN.S FOR DB.ADMIN.T;');
    });
});
