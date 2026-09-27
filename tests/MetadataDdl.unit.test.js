const {
    buildTableDdl,
    buildViewDdl,
    buildProcedureDdl,
    buildExternalTableDdl,
    buildSynonymDdl,
    isExternalLayoutZoneCount,
    reconstructExternalLayout,
} = require('../dist/cjs/metadata/ddl');
const { normalizeObjectName } = require('../dist/cjs/metadata/NzMetadata');

describe('metadata DDL reconstruction', () => {
    test('reconstructs fixed-format layout from ordered catalog zones', () => {
        expect(reconstructExternalLayout(4, [
            { usetype: 'FILLER', name: 'F1', type: 'CHAR(2)', style: 'INTERNAL', length: 'BYTES 2' },
            { name: 'SELECT', type: 'INT4', style: 'DECIMAL', length: 'BYTES 4', nullif: "&&2 = ''" },
            { name: 'DT', type: 'DATE', style: 'YMD', delimiter: '-', length: 'BYTES 10' },
            { name: ' DATE FIELD ', type: 'DATE', style: 'YMD', delimiter: ' ', length: 'BYTES 10' },
        ])).toBe("FILLER F1 CHAR(2) INTERNAL BYTES 2, \"SELECT\" INT4 DECIMAL BYTES 4 NULLIF &&2 = '', DT DATE YMD '-' BYTES 10, \" DATE FIELD \" DATE YMD ' ' BYTES 10");
        expect(isExternalLayoutZoneCount('3')).toBe(true);
        expect(isExternalLayoutZoneCount(0)).toBe(false);
        expect(() => reconstructExternalLayout(2, [{ type: 'INT4', length: 'BYTES 4' }]))
            .toThrow('_V_EXTZONES returned 1');
    });

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
        expect(buildTableDdl('DB', 'ADMIN', 'SELECT', [
            { name: 'FROM', typeName: 'INTEGER', notNull: false, defaultValue: null, description: null },
        ], [], [], [], null)).toContain('CREATE TABLE DB.ADMIN."SELECT"');

        expect(buildViewDdl('DB', 'ADMIN', 'V', 'SELECT ID FROM T;'))
            .toBe('CREATE OR REPLACE VIEW DB.ADMIN.V AS\nSELECT ID FROM T;');

        const procedure = buildProcedureDdl('DB', 'ADMIN', {
            name: 'P', signature: 'P(INTEGER)', arguments: 'x INTEGER', returns: 'INTEGER',
            executedAsOwner: true, description: "owner's procedure",
            source: 'BEGIN RETURN 1; END;',
        });
        expect(procedure).toContain('CREATE OR REPLACE PROCEDURE DB.ADMIN.P(x INTEGER)');
        expect(procedure).toContain('COMMENT ON PROCEDURE DB.ADMIN.P(INTEGER)');
        expect(procedure).toContain("owner''s procedure");

        const external = buildExternalTableDdl(
            'DB', 'ADMIN', 'E', '/tmp/data.txt',
            [{ name: 'ID', typeName: 'INTEGER', notNull: false }],
            new Map([['remotesource', 'jdbc'], ['maxerrors', 10]])
        );
        expect(external).toContain("DATAOBJECT('/tmp/data.txt')");
        expect(external).toContain("REMOTESOURCE 'jdbc'");
        expect(external).toContain('MAXERRORS 10');

        const extended = buildExternalTableDdl('DB', 'ADMIN', 'E', null,
            [{ name: 'ID', typeName: 'INTEGER', notNull: false }],
            new Map([['compress', 'zstd'], ['recorddelim', '\r\n'], ['layout', 'BYTES 4'],
                ['includezeroseconds', false], ['meridiandelim', '.'], ['maxerrors', 0]])
        );
        expect(extended).toContain('COMPRESS zstd');
        expect(extended).toContain("RECORDDELIM '\r\n'");
        expect(extended).toContain('LAYOUT (BYTES 4)');
        expect(extended).toContain('INCLUDEZEROSECONDS false');
        expect(extended).toContain('MAXERRORS 0');

        expect(buildSynonymDdl('DB', 'ADMIN', 'S', 'DB.ADMIN.T', null))
            .toBe('CREATE SYNONYM DB.ADMIN.S FOR DB.ADMIN.T;');
        expect(buildSynonymDdl('DB', 'ADMIN', 'S', 'DB.ADMIN.T', "owner's alias"))
            .toBe("CREATE SYNONYM DB.ADMIN.S FOR DB.ADMIN.T;\nCOMMENT ON SYNONYM DB.ADMIN.S IS 'owner''s alias';");
        expect(buildSynonymDdl('DB', 'ADMIN', 'S', '"Data.Schema"."Target.Name"', null))
            .toBe('CREATE SYNONYM DB.ADMIN.S FOR "Data.Schema"."Target.Name";');
        expect(buildSynonymDdl('DB', 'ADMIN', 'S', '  " Schema Name " . " Target Name "  ', null))
            .toBe('CREATE SYNONYM DB.ADMIN.S FOR " Schema Name "." Target Name ";');
        expect(buildSynonymDdl('DB', 'ADMIN', 'S', '"Target.Name"', null, 'OTHER_DB', 'Data.Schema'))
            .toBe('CREATE SYNONYM DB.ADMIN.S FOR OTHER_DB."Data.Schema"."Target.Name";');
        expect(buildSynonymDdl('DB', 'ADMIN', 'S', 'TARGET', null, 'OTHER_DB', null))
            .toBe('CREATE SYNONYM DB.ADMIN.S FOR OTHER_DB..TARGET;');
    });
});
