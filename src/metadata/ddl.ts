/** Pure Netezza DDL formatters; catalog access stays in NzMetadata. */

export interface DdlColumn {
    name: string;
    typeName: string;
    notNull: boolean;
    defaultValue: string | null;
    description: string | null;
}
export interface DdlKey {
    name: string;
    keyType: string;
    typeChar: string;
    columns: string[];
    pkDatabase: string | null;
    pkSchema: string | null;
    pkRelation: string | null;
    pkColumns: string[];
    updateType: string;
    deleteType: string;
}
export interface DdlProcedure {
    name: string;
    arguments: string | null;
    returns: string;
    executedAsOwner: boolean;
    description: string | null;
    source: string;
}
export interface DdlExternalColumn {
    name: string;
    typeName: string;
    notNull: boolean;
}
export type ExternalOptionKind = 'string' | 'number' | 'boolean';
export interface ExternalOption {
    keyword: string;
    column: string;
    kind: ExternalOptionKind;
}
export const externalOptions: readonly ExternalOption[] = [
    { keyword: 'DELIMITER', column: 'DELIM', kind: 'string' },
    { keyword: 'ENCODING', column: 'ENCODING', kind: 'string' },
    { keyword: 'TIMESTYLE', column: 'TIMESTYLE', kind: 'string' },
    { keyword: 'REMOTESOURCE', column: 'REMOTESOURCE', kind: 'string' },
    { keyword: 'SKIPROWS', column: 'SKIPROWS', kind: 'number' },
    { keyword: 'MAXERRORS', column: 'MAXERRORS', kind: 'number' },
    { keyword: 'ESCAPECHAR', column: 'ESCAPE', kind: 'string' },
    { keyword: 'DECIMALDELIM', column: 'DECIMALDELIM', kind: 'string' },
    { keyword: 'LOGDIR', column: 'LOGDIR', kind: 'string' },
    { keyword: 'QUOTEDVALUE', column: 'QUOTEDVALUE', kind: 'string' },
    { keyword: 'NULLVALUE', column: 'NULLVALUE', kind: 'string' },
    { keyword: 'CRINSTRING', column: 'CRINSTRING', kind: 'boolean' },
    { keyword: 'TRUNCSTRING', column: 'TRUNCSTRING', kind: 'boolean' },
    { keyword: 'CTRLCHARS', column: 'CTRLCHARS', kind: 'boolean' },
    { keyword: 'IGNOREZERO', column: 'IGNOREZERO', kind: 'boolean' },
    { keyword: 'TIMEEXTRAZEROS', column: 'TIMEEXTRAZEROS', kind: 'boolean' },
    { keyword: 'Y2BASE', column: 'Y2BASE', kind: 'number' },
    { keyword: 'FILLRECORD', column: 'FILLRECORD', kind: 'boolean' },
    { keyword: 'COMPRESS', column: 'COMPRESS', kind: 'boolean' },
    { keyword: 'INCLUDEHEADER', column: 'INCLUDEHEADER', kind: 'boolean' },
    { keyword: 'LFINSTRING', column: 'LFINSTRING', kind: 'boolean' },
    { keyword: 'DATESTYLE', column: 'DATESTYLE', kind: 'string' },
    { keyword: 'DATEDELIM', column: 'DATEDELIM', kind: 'string' },
    { keyword: 'TIMEDELIM', column: 'TIMEDELIM', kind: 'string' },
    { keyword: 'BOOLSTYLE', column: 'BOOLSTYLE', kind: 'string' },
    { keyword: 'FORMAT', column: 'FORMAT', kind: 'string' },
    { keyword: 'SOCKETBUFSIZE', column: 'SOCKETBUFSIZE', kind: 'number' },
    { keyword: 'RECORDDELIM', column: 'RECORDDELIM', kind: 'string' },
    { keyword: 'MAXROWS', column: 'MAXROWS', kind: 'number' },
    { keyword: 'REQUIREQUOTES', column: 'REQUIREQUOTES', kind: 'boolean' },
    { keyword: 'RECORDLENGTH', column: 'RECORDLENGTH', kind: 'number' },
    { keyword: 'DATETIMEDELIM', column: 'DATETIMEDELIM', kind: 'string' },
    { keyword: 'REJECTFILE', column: 'REJECTFILE', kind: 'string' },
];

export function quoteIdentifier(name: string): string {
    return /^[A-Z_][A-Z0-9_]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"';
}
const quoteString = (value: string): string => value.replace(/'/g, "''");
const qualified = (database: string, schema: string, name: string): string =>
    [database, schema, name].map(quoteIdentifier).join('.');
const quotedList = (values: readonly string[]): string => values.map(quoteIdentifier).join(', ');

export function buildTableDdl(
    database: string,
    schema: string,
    table: string,
    columns: readonly DdlColumn[],
    distribution: readonly string[],
    organization: readonly string[],
    keys: readonly DdlKey[],
    comment: string | null
): string {
    if (columns.length === 0) throw new Error('Table ' + table + ' has no columns');
    const name = qualified(database, schema, table);
    const lines = [
        'CREATE TABLE ' + name,
        '(',
        columns
            .map((column) => {
                let line = '    ' + quoteIdentifier(column.name) + ' ' + column.typeName;
                if (column.notNull) line += ' NOT NULL';
                if (column.defaultValue !== null) line += ' DEFAULT ' + column.defaultValue;
                return line;
            })
            .join(',\n'),
        distribution.length ? ')\nDISTRIBUTE ON (' + quotedList(distribution) + ')' : ')\nDISTRIBUTE ON RANDOM',
    ];
    if (organization.length) lines.push('ORGANIZE ON (' + quotedList(organization) + ')');
    lines.push(';', '');
    for (const key of keys) {
        const prefix =
            'ALTER TABLE ' +
            name +
            ' ADD CONSTRAINT ' +
            quoteIdentifier(key.name) +
            ' ' +
            key.keyType +
            ' (' +
            quotedList(key.columns) +
            ')';
        if (key.typeChar === 'p' || key.typeChar === 'u') lines.push(prefix + ';');
        else if (key.typeChar === 'f' && key.pkColumns.length && key.pkDatabase && key.pkSchema && key.pkRelation) {
            lines.push(
                prefix +
                    ' REFERENCES ' +
                    qualified(key.pkDatabase, key.pkSchema, key.pkRelation) +
                    ' (' +
                    quotedList(key.pkColumns) +
                    ') ON DELETE ' +
                    key.deleteType +
                    ' ON UPDATE ' +
                    key.updateType +
                    ';'
            );
        }
    }
    if (comment) lines.push('', 'COMMENT ON TABLE ' + name + " IS '" + quoteString(comment) + "';");
    for (const column of columns) {
        if (column.description)
            lines.push(
                'COMMENT ON COLUMN ' +
                    name +
                    '.' +
                    quoteIdentifier(column.name) +
                    " IS '" +
                    quoteString(column.description) +
                    "';"
            );
    }
    return lines.join('\n');
}

export function buildViewDdl(database: string, schema: string, view: string, definition: string): string {
    const body = definition.trim().replace(/;\s*$/, '').trimEnd();
    return 'CREATE OR REPLACE VIEW ' + qualified(database, schema, view) + ' AS\n' + body + ';';
}

export function buildProcedureDdl(database: string, schema: string, procedure: DdlProcedure): string {
    const argumentsText = procedure.arguments?.trim() ?? '';
    const argumentsClause = !argumentsText
        ? '()'
        : argumentsText.startsWith('(') && argumentsText.endsWith(')')
          ? argumentsText
          : '(' + argumentsText + ')';
    const name = qualified(database, schema, procedure.name);
    const normalizedReturn = [
        'CHARACTER VARYING',
        'NATIONAL CHARACTER VARYING',
        'NATIONAL CHARACTER',
        'CHARACTER',
    ].includes(procedure.returns.trim().toUpperCase())
        ? procedure.returns.trim().toUpperCase() + '(ANY)'
        : procedure.returns;
    const lines = [
        'CREATE OR REPLACE PROCEDURE ' + name + argumentsClause,
        'RETURNS ' + normalizedReturn,
        procedure.executedAsOwner ? 'EXECUTE AS OWNER' : 'EXECUTE AS CALLER',
        'LANGUAGE NZPLSQL AS',
        'BEGIN_PROC',
        procedure.source,
        'END_PROC;',
    ];
    if (procedure.description)
        lines.push('COMMENT ON PROCEDURE ' + name + " IS '" + quoteString(procedure.description) + "';");
    return lines.join('\n');
}

export function buildExternalTableDdl(
    database: string,
    schema: string,
    table: string,
    dataObject: string | null,
    columns: readonly DdlExternalColumn[],
    options: ReadonlyMap<string, unknown>
): string {
    if (!columns.length) throw new Error('External table ' + table + ' has no columns');
    const lines = [
        'CREATE EXTERNAL TABLE ' + qualified(database, schema, table),
        '(',
        columns
            .map(
                (column) =>
                    '    ' + quoteIdentifier(column.name) + ' ' + column.typeName + (column.notNull ? ' NOT NULL' : '')
            )
            .join(',\n'),
        ')',
        'USING',
        '(',
    ];
    if (dataObject !== null) lines.push("    DATAOBJECT('" + quoteString(dataObject) + "')");
    for (const option of externalOptions) {
        const value = options.get(option.column.toLowerCase());
        if (value === null || value === undefined) continue;
        const rendered =
            option.kind === 'string'
                ? "'" + quoteString(String(value)) + "'"
                : option.kind === 'boolean'
                  ? ['true', 't', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase())
                      ? 'true'
                      : 'false'
                  : String(value);
        lines.push('    ' + option.keyword + ' ' + rendered);
    }
    lines.push(');');
    return lines.join('\n');
}

export function buildSynonymDdl(
    database: string,
    schema: string,
    synonym: string,
    reference: string,
    description: string | null
): string {
    const target = reference.split('.').map(quoteIdentifier).join('.');
    const lines = ['CREATE SYNONYM ' + qualified(database, schema, synonym) + ' FOR ' + target + ';'];
    if (description)
        lines.push('COMMENT ON SYNONYM ' + quoteIdentifier(synonym) + " IS '" + quoteString(description) + "';");
    return lines.join('\n');
}
