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
    signature?: string | null;
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
export type ExternalOptionKind = 'string' | 'number' | 'boolean' | 'compression' | 'layout';
export interface ExternalOption {
    keyword: string;
    column: string;
    kind: ExternalOptionKind;
}

function layoutText(value: unknown): string {
    return value === null || value === undefined ? '' : String(value).trim();
}

function layoutRawText(value: unknown): string {
    return value === null || value === undefined ? '' : String(value);
}

function catalogValue(row: Record<string, unknown>, column: string): unknown {
    return row[column] ?? row[column.toLowerCase()] ?? row[column.toUpperCase()];
}

export function isExternalLayoutZoneCount(value: unknown): boolean {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
    return typeof value === 'string' && /^\d+$/u.test(value.trim()) && Number(value.trim()) > 0;
}

export function reconstructExternalLayout(catalogLayout: unknown, zones: readonly Record<string, unknown>[]): string | null {
    if (catalogLayout === null || catalogLayout === undefined) return null;
    const raw = layoutText(catalogLayout);
    if (!raw || raw === '0') return null;
    if (!/^\d+$/u.test(raw)) return raw;
    const count = Number(raw);
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    if (zones.length !== count) {
        throw new Error(`Cannot reconstruct external table LAYOUT: catalog reports ${count} zones, but _V_EXTZONES returned ${zones.length}`);
    }
    return zones.map((row, index) => {
        const get = (column: string): string => layoutText(catalogValue(row, column));
        const useType = get('usetype').toUpperCase();
        if (useType && useType !== 'REF' && useType !== 'FILLER') {
            throw new Error(`Cannot reconstruct external table LAYOUT: unsupported zone use type ${useType}`);
        }
        const name = layoutRawText(catalogValue(row, 'name'));
        const type = get('type');
        const style = get('style');
        const length = get('length');
        const delimiter = layoutRawText(catalogValue(row, 'delimiter'));
        const nullIf = get('nullif');
        if (!length) throw new Error(`Cannot reconstruct external table LAYOUT: zone ${index + 1} has no length`);
        for (const field of ['around', 'endian', 'alignment', 'modulus']) {
            if (get(field)) {
                throw new Error(`Cannot reconstruct external table LAYOUT: zone ${index + 1} uses unsupported ${field.toUpperCase()} metadata`);
            }
        }
        const parts = [useType, name ? quoteIdentifier(name) : '', type, style];
        if (delimiter) {
            if (!style) throw new Error(`Cannot reconstruct external table LAYOUT: zone ${index + 1} has a delimiter without a style`);
            if (!style.includes("'")) parts.push(`'${quoteString(delimiter)}'`);
        }
        parts.push(length);
        if (nullIf) parts.push(/^NULLIF\b/iu.test(nullIf) ? nullIf : `NULLIF ${nullIf}`);
        return parts.filter(Boolean).join(' ');
    }).join(', ');
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
    { keyword: 'COMPRESS', column: 'COMPRESS', kind: 'compression' },
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
    { keyword: 'LAYOUT', column: 'LAYOUT', kind: 'layout' },
    { keyword: 'INCLUDEZEROSECONDS', column: 'INCLUDEZEROSECONDS', kind: 'boolean' },
    { keyword: 'MERIDIANDELIM', column: 'MERIDIANDELIM', kind: 'string' },
];

export function quoteIdentifier(name: string): string {
    return /^[A-Z][A-Z0-9_]*$/.test(name) && !NETEZZA_RESERVED_IDENTIFIERS.has(name)
        ? name
        : '"' + name.replace(/"/g, '""') + '"';
}

const NETEZZA_RESERVED_IDENTIFIERS = new Set(
    'ABORT ALL ALLOCATE ANALYSE ANALYZE AND ANY AS ASC AUTOMAINT AWSS3 AZUREBLOB BETWEEN BINARY BIT BOTH CASE CAST CHAR CHARACTER CHECK CLUSTER COALESCE COLLATE COLLATION COLUMN CONSTRAINT COPY CROSS CURRENT CURRENT_CATALOG CURRENT_DATE CURRENT_DB CURRENT_SCHEMA CURRENT_SID CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURRENT_USERID CURRENT_USEROID DAYSPERROW DEALLOCATE DEC DECIMAL DECODE DEFAULT DEREGISTER DESC DISTINCT DISTRIBUTE DO ELSE END EXCEPT EXCLUDE EXISTS EXPLAIN EXPRESS EXTEND EXTERNAL EXTRACT FALSE FIRST FLOAT FOLLOWING FOR FOREIGN FROM FULL FUNCTION GENSTATS GLOBAL GROUP HAVING HISTOGRAM IDENTIFIER_CASE ILIKE IN INDEX INITIALLY INNER INOUT INTERSECT INTERVAL INTO JOURNAL LEADING LEFT LIKE LIMIT LOAD LOCAL LOCK MINUS MOVE NATURAL NCHAR NEW NOCASCADE NOT NOTNULL NULL NULLS NUMERIC NVL NVL2 OFFSET OFF OLD ON ONLINE ONLY OR ORDER OTHERS OUT OUTER OVER OVERLAPS PAUSESTEPS PAUSETIME PARTITION POSITION PRECEDING PRECISION PRESERVE PRIMARY REGISTER RESET REUSE RIGHT ROWS SELECT SESSION_USER SETOF SHOW SOME TABLE TEMPORAL THEN TIES TIME TIME_TRAVEL_ENABLE TIMESTAMP TO TRAILING TRANSACTION TRIGGER TRIM TRUE UNBOUNDED UNION UNIQUE USER USING VACUUM VARCHAR VERBOSE VERSION VIEW WHEN WHERE WITH WRITE CTID OID XMIN CMIN XMAX CMAX TABLEOID ROWID DATASLICEID CREATEXID DELETEXID'.split(/\s+/)
);
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
    return 'CREATE OR REPLACE VIEW ' + qualified(database, schema, view) + ' AS\n' + (definition || '');
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
    if (procedure.description) {
        const signatureStart = procedure.signature?.indexOf('(') ?? -1;
        if (signatureStart < 0) throw new Error('Procedure signature is required to reconstruct its comment');
        const commentSignature = procedure.signature!.slice(signatureStart);
        lines.push('COMMENT ON PROCEDURE ' + name + commentSignature + " IS '" + quoteString(procedure.description) + "';");
    }
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
        if (option.kind === 'layout') {
            const layout = String(value).trim();
            if (!layout) continue;
            const zoneDefinitions = layout.startsWith('(') && layout.endsWith(')')
                ? layout
                : '(' + layout + ')';
            lines.push('    LAYOUT ' + zoneDefinitions);
            continue;
        }
        const rendered =
            option.kind === 'string'
                ? "'" + quoteString(String(value)) + "'"
                : option.kind === 'compression'
                  ? ['true', 't', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase())
                      ? 'true'
                      : ['false', 'f', '0', 'no', 'off'].includes(String(value).trim().toLowerCase())
                        ? 'false'
                        : String(value)
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
    description: string | null,
    referenceDatabase: string | null = null,
    referenceSchema: string | null = null
): string {
    const parts = splitIdentifierPath(reference);
    if (parts.length === 1 && referenceDatabase) parts.unshift(referenceDatabase, referenceSchema ?? '');
    else if (parts.length === 1 && referenceSchema) parts.unshift(referenceSchema);
    else if (parts.length === 2 && referenceDatabase) parts.unshift(referenceDatabase);
    const target = parts.map(part => part ? quoteIdentifier(part) : '').join('.');
    const lines = ['CREATE SYNONYM ' + qualified(database, schema, synonym) + ' FOR ' + target + ';'];
    if (description)
        lines.push('COMMENT ON SYNONYM ' + qualified(database, schema, synonym) + " IS '" + quoteString(description) + "';");
    return lines.join('\n');
}

function splitIdentifierPath(value: string): string[] {
    const rawParts: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"') {
            if (quoted && value[index + 1] === '"') {
                current += '""';
                index += 1;
            } else {
                current += character;
                quoted = !quoted;
            }
        } else if (character === '.' && !quoted) {
            rawParts.push(current);
            current = '';
        } else current += character;
    }
    if (quoted) throw new Error('Invalid synonym target: ' + value);
    rawParts.push(current);
    const parts = rawParts.map((rawPart) => {
        const part = rawPart.trim();
        if (!part.startsWith('"')) {
            if (part.includes('"')) throw new Error('Invalid synonym target: ' + value);
            return part;
        }
        if (part.length < 2 || !part.endsWith('"')) throw new Error('Invalid synonym target: ' + value);
        let identifier = '';
        for (let index = 1; index < part.length - 1; index += 1) {
            if (part[index] === '"') {
                if (part[index + 1] !== '"' || index + 1 >= part.length - 1)
                    throw new Error('Invalid synonym target: ' + value);
                identifier += '"';
                index += 1;
            } else identifier += part[index];
        }
        return identifier;
    });
    const hasOmittedSchema = parts.length === 3 && parts[0] !== '' && parts[1] === '' && parts[2] !== '';
    if (parts.length > 3 || (parts.some(part => part === '') && !hasOmittedSchema)) {
        throw new Error('Invalid synonym target: ' + value);
    }
    return parts;
}
