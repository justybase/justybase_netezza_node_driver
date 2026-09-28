import type { NzConnection } from '../NzConnection';
import { NzDatabaseError } from '../errors/NzDatabaseError';
import { escapeLiteral } from '../protocol/sqlParameters';
import {
    buildTableDdl,
    buildViewDdl,
    buildProcedureDdl,
    buildExternalTableDdl,
    buildSynonymDdl,
    externalOptions,
    isExternalLayoutZoneCount,
    reconstructExternalLayout,
    quoteIdentifier,
    type DdlColumn,
    type DdlProcedure,
    type DdlExternalColumn,
} from './ddl';

type CatalogRow = Record<string, unknown>;
export interface NzTableInfo {
    schema: string;
    tableName: string;
    owner: string | null;
    objectType: string | null;
    objectId: number | null;
    rowCount: number | null;
}
export interface NzViewInfo {
    schema: string;
    viewName: string;
    owner: string | null;
    objectId: number | null;
    definition: string | null;
}
export interface NzProcedureInfo {
    schema: string;
    name: string;
    owner: string | null;
    objectId: number | null;
    signature: string | null;
    returns: string | null;
    source: string | null;
}
export interface NzColumnInfo {
    name: string;
    ordinal: number;
    typeName: string;
    nullable: boolean;
    objectId: number | null;
}
export interface NzDetailedColumnInfo {
    schema: string;
    name: string;
    ordinal: number;
    typeName: string;
    notNull: boolean;
    defaultValue: string | null;
    description: string | null;
}
export interface NzTableKeyInfo {
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
export interface NzSequenceInfo {
    schema: string;
    name: string;
    owner: string | null;
    objectId: number | null;
}
export interface NzFunctionInfo {
    schema: string;
    name: string;
    owner: string | null;
    objectId: number | null;
    signature: string | null;
    returns: string | null;
    environment: string | null;
    isSqlReadLauncher: boolean;
}
export interface NzSynonymInfo {
    schema: string;
    name: string;
    reference: string | null;
    referenceDatabase: string | null;
    referenceSchema: string | null;
    description: string | null;
}
export interface NzConstraintInfo {
    schema: string;
    relation: string;
    name: string;
    typeChar: string;
    column: string;
    pkDatabase: string | null;
    pkSchema: string | null;
    pkRelation: string | null;
    pkColumn: string | null;
    updateType: string | null;
    deleteType: string | null;
}
export interface NzDistributionKeyInfo {
    schema: string;
    table: string;
    column: string;
    ordinal: number;
}
export interface NzOrganizeKeyInfo {
    schema: string;
    table: string;
    column: string;
    ordinal: number;
}
export interface NzObjectDetailInfo {
    schema: string;
    name: string;
    objectType: string;
    owner: string | null;
    objectId: number | null;
    description: string | null;
    createdAt: string | null;
}
export interface NzObjectInfo {
    schema: string;
    name: string;
    objectType: string;
    owner: string | null;
    objectId: number | null;
}
export interface NzPrincipalInfo {
    name: string;
    objectId: number | null;
}
export interface NzQueryHistoryInfo {
    sessionId: number | null;
    username: string | null;
    database: string | null;
    queryText: string | null;
    submitTime: string | null;
    startTime: string | null;
    resultRows: number | null;
}
export interface NzDdlBatchResult {
    schema: string;
    name: string;
    ddl: string;
    error: string | null;
}

const optionalText = (row: CatalogRow, name: string): string | null =>
    row[name] === null || row[name] === undefined ? null : String(row[name]);
function text(row: CatalogRow, name: string): string {
    const value = optionalText(row, name);
    if (value === null) throw new TypeError('Missing catalog field: ' + name);
    return value;
}
const number = (row: CatalogRow, name: string): number | null =>
    row[name] === null || row[name] === undefined ? null : Number(row[name]);
const boolean = (row: CatalogRow, name: string): boolean =>
    ['true', 't', '1', 'yes', 'on'].includes(
        String(row[name] ?? '')
            .trim()
            .toLowerCase()
    );
const missingRelation = (error: unknown): boolean => error instanceof NzDatabaseError && error.code === '42P01';
function requireUniqueSchema(rows: CatalogRow[], name: string): void {
    if (new Set(rows.map((row) => text(row, 'schema'))).size > 1)
        throw new Error(name + ' exists in several schemas; pass schema explicitly');
}
function normalizeIdentifier(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new TypeError('Empty SQL identifier');
    if (trimmed.startsWith('"')) {
        if (!trimmed.endsWith('"') || trimmed.length < 2) throw new TypeError('Invalid quoted identifier: ' + value);
        return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return trimmed.toUpperCase();
}
export function normalizeObjectName(name: string, schema?: string): { schema: string | null; name: string } {
    const parts: string[] = [];
    let current = '';
    let quoted = false;
    let parentheses = 0;
    for (let index = 0; index < name.length; index++) {
        const char = name[index];
        if (char === '"') {
            if (quoted && name[index + 1] === '"') {
                current += '""';
                index++;
            } else {
                quoted = !quoted;
                current += char;
            }
        } else if (!quoted && char === '(') {
            parentheses++;
            current += char;
        } else if (!quoted && char === ')') {
            parentheses--;
            current += char;
        } else if (!quoted && parentheses === 0 && char === '.') {
            parts.push(current);
            current = '';
        } else current += char;
    }
    parts.push(current);
    if (quoted || parentheses !== 0 || parts.length < 1 || parts.length > 3)
        throw new TypeError('Invalid qualified object name: ' + name);
    return {
        schema:
            parts.length >= 2
                ? normalizeIdentifier(parts[parts.length - 2])
                : schema
                  ? normalizeIdentifier(schema)
                  : null,
        name: normalizeIdentifier(parts[parts.length - 1]),
    };
}

/** Catalog and DDL helpers bound to one connection. */
export class NzMetadata {
    constructor(private readonly connection: NzConnection) {}
    private async rows(sql: string): Promise<CatalogRow[]> {
        const result = await this.connection.query<Record<string, unknown>>(sql);
        return result.rows.map((row) =>
            Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]))
        );
    }
    async getSchemas(): Promise<string[]> {
        return (await this.rows('SELECT schema FROM _v_schema ORDER BY schema')).map((row) => text(row, 'schema'));
    }
    async getDatabases(): Promise<string[]> {
        return (await this.rows('SELECT database FROM _v_database ORDER BY database')).map((row) =>
            text(row, 'database')
        );
    }
    async getCurrentDatabase(): Promise<string | null> {
        const rows = await this.rows('SELECT current_catalog');
        return rows[0] ? optionalText(rows[0], Object.keys(rows[0])[0]) : null;
    }
    async getCurrentSchema(): Promise<string | null> {
        const rows = await this.rows('SELECT current_schema');
        return rows[0] ? optionalText(rows[0], Object.keys(rows[0])[0]) : null;
    }
    async getTables(schema?: string, pattern?: string): Promise<NzTableInfo[]> {
        let sql =
            'SELECT schema, tablename, owner, objtype, objid, reltuples FROM _v_table WHERE tablename IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        if (pattern !== undefined) sql += ' AND tablename LIKE ' + escapeLiteral(pattern);
        sql +=
            " AND schema NOT IN ('DEFINITION_SCHEMA', 'INZA', 'NZ_QUERY_HISTORY') AND objtype <> 'SYSTEM_TABLE' ORDER BY schema, tablename";
        return (await this.rows(sql)).map((row) => ({
            schema: text(row, 'schema'),
            tableName: text(row, 'tablename'),
            owner: optionalText(row, 'owner'),
            objectType: optionalText(row, 'objtype'),
            objectId: number(row, 'objid'),
            rowCount: number(row, 'reltuples'),
        }));
    }
    async getViews(schema?: string, pattern?: string): Promise<NzViewInfo[]> {
        let sql = 'SELECT schema, viewname, owner, objid, definition FROM _v_view WHERE viewname IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        if (pattern !== undefined) sql += ' AND viewname LIKE ' + escapeLiteral(pattern);
        return (await this.rows(sql + ' ORDER BY schema, viewname')).map((row) => ({
            schema: text(row, 'schema'),
            viewName: text(row, 'viewname'),
            owner: optionalText(row, 'owner'),
            objectId: number(row, 'objid'),
            definition: optionalText(row, 'definition'),
        }));
    }
    async getProcedures(schema?: string, pattern?: string): Promise<NzProcedureInfo[]> {
        let sql =
            'SELECT schema, procedure, owner, objid, proceduresignature, returns, proceduresource FROM _v_procedure WHERE procedure IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        if (pattern !== undefined) sql += ' AND procedure LIKE ' + escapeLiteral(pattern);
        return (await this.rows(sql + ' ORDER BY schema, procedure')).map((row) => ({
            schema: text(row, 'schema'),
            name: text(row, 'procedure'),
            owner: optionalText(row, 'owner'),
            objectId: number(row, 'objid'),
            signature: optionalText(row, 'proceduresignature'),
            returns: optionalText(row, 'returns'),
            source: optionalText(row, 'proceduresource'),
        }));
    }
    async getColumns(table: string, schema?: string): Promise<NzColumnInfo[]> {
        const target = normalizeObjectName(table, schema);
        let sql =
            'SELECT attname, attnum, format_type, attnotnull, objid FROM _v_relation_column WHERE name = ' +
            escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND schema = ' + escapeLiteral(target.schema);
        return (await this.rows(sql + ' ORDER BY attnum')).map((row) => ({
            name: text(row, 'attname'),
            ordinal: number(row, 'attnum') ?? 0,
            typeName: text(row, 'format_type'),
            nullable: !boolean(row, 'attnotnull'),
            objectId: number(row, 'objid'),
        }));
    }
    async getDistributionKey(table: string, schema?: string): Promise<string[]> {
        const target = normalizeObjectName(table, schema);
        let sql = 'SELECT attname FROM _v_table_dist_map WHERE tablename = ' + escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND schema = ' + escapeLiteral(target.schema);
        return (await this.rows(sql + ' ORDER BY distattnum')).map((row) => text(row, 'attname'));
    }
    async getTableSizes(schema?: string, pattern?: string): Promise<CatalogRow[]> {
        let sql =
            'SELECT schema, tablename AS table_name, used_bytes, allocated_bytes, (used_bytes / 1048576)::BIGINT AS size_mb, skew FROM _v_table_storage_stat WHERE tablename IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        if (pattern !== undefined) sql += ' AND tablename LIKE ' + escapeLiteral(pattern);
        return this.rows(sql + ' ORDER BY used_bytes DESC');
    }
    async getSequences(schema?: string): Promise<NzSequenceInfo[]> {
        let sql = 'SELECT schema, seqname, owner, objid FROM _v_sequence WHERE seqname IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        return (await this.rows(sql + ' ORDER BY schema, seqname')).map((row) => ({
            schema: text(row, 'schema'),
            name: text(row, 'seqname'),
            owner: optionalText(row, 'owner'),
            objectId: number(row, 'objid'),
        }));
    }
    async getSynonyms(schema?: string): Promise<NzSynonymInfo[]> {
        let sql =
            'SELECT schema, synonym_name, refobjname, refdatabase, refschema, description FROM _v_synonym WHERE synonym_name IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        return (await this.rows(sql + ' ORDER BY schema, synonym_name')).map((row) => ({
            schema: text(row, 'schema'),
            name: text(row, 'synonym_name'),
            reference: optionalText(row, 'refobjname'),
            referenceDatabase: optionalText(row, 'refdatabase'),
            referenceSchema: optionalText(row, 'refschema'),
            description: optionalText(row, 'description'),
        }));
    }
    async getSessions(): Promise<CatalogRow[]> {
        return this.rows(
            'SELECT id AS session_id, username, dbname AS database_name, conntime, priority, status, type AS client_type, client_os_username FROM _v_session ORDER BY conntime DESC'
        );
    }
    async getFunctions(schema?: string): Promise<NzFunctionInfo[]> {
        let sql =
            'SELECT schema, function, owner, objid, functionsignature, returns, env FROM _v_function WHERE function IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        return (await this.rows(sql + ' ORDER BY schema, function')).map((row) => {
            const environment = optionalText(row, 'env');
            return {
                schema: text(row, 'schema'),
                name: text(row, 'function'),
                owner: optionalText(row, 'owner'),
                objectId: number(row, 'objid'),
                signature: optionalText(row, 'functionsignature'),
                returns: optionalText(row, 'returns'),
                environment,
                isSqlReadLauncher: environment?.toLowerCase().includes('com.ibm.nz.fq.sqlreadlauncher') ?? false,
            };
        });
    }
    async getConstraints(schema?: string): Promise<NzConstraintInfo[]> {
        let sql =
            'SELECT schema, relation, constraintname, contype, attname, pkdatabase, pkschema,' +
            ' pkrelation, pkattname, updt_type, del_type FROM _v_relation_keydata WHERE relation IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        return (await this.rows(sql + ' ORDER BY schema, relation, conseq')).map((row) => ({
            schema: text(row, 'schema'),
            relation: text(row, 'relation'),
            name: text(row, 'constraintname'),
            typeChar: text(row, 'contype').charAt(0),
            column: optionalText(row, 'attname') ?? '',
            pkDatabase: optionalText(row, 'pkdatabase'),
            pkSchema: optionalText(row, 'pkschema'),
            pkRelation: optionalText(row, 'pkrelation'),
            pkColumn: optionalText(row, 'pkattname'),
            updateType: optionalText(row, 'updt_type'),
            deleteType: optionalText(row, 'del_type'),
        }));
    }
    async getAllDistributionKeys(schema?: string): Promise<NzDistributionKeyInfo[]> {
        let sql = 'SELECT schema, tablename, attname, distattnum FROM _v_table_dist_map WHERE tablename IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        return (await this.rows(sql + ' ORDER BY schema, tablename, distseqno')).map((row) => ({
            schema: text(row, 'schema'),
            table: text(row, 'tablename'),
            column: text(row, 'attname'),
            ordinal: number(row, 'distattnum') ?? 0,
        }));
    }
    async getOrganizeKeys(schema?: string): Promise<NzOrganizeKeyInfo[]> {
        let sql = 'SELECT schema, tablename, attname, attnum FROM _v_table_organize_column WHERE tablename IS NOT NULL';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        return (await this.rows(sql + ' ORDER BY schema, tablename, orgseqno')).map((row) => ({
            schema: text(row, 'schema'),
            table: text(row, 'tablename'),
            column: text(row, 'attname'),
            ordinal: number(row, 'attnum') ?? 0,
        }));
    }
    async getObjectDetails(schema?: string): Promise<NzObjectDetailInfo[]> {
        return this.objectDetails(undefined, schema);
    }
    async searchObjectsDetailed(pattern: string, schema?: string): Promise<NzObjectDetailInfo[]> {
        return this.objectDetails(pattern, schema);
    }
    private async objectDetails(pattern?: string, schema?: string): Promise<NzObjectDetailInfo[]> {
        let sql =
            'SELECT schema, objname, objtype, owner, objid, description, createdate' +
            ' FROM _v_object_data WHERE objname IS NOT NULL';
        if (pattern !== undefined) sql += ' AND UPPER(objname) LIKE UPPER(' + escapeLiteral('%' + pattern + '%') + ')';
        if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
        sql +=
            " AND objtype NOT IN ('AGGREGATE','CONSTRAINT','DATABASE','DATATYPE','GROUP'," +
            "'MANAGEMENT INDEX','MANAGEMENT SEQ','MANAGEMENT TABLE','MANAGEMENT VIEW'," +
            "'SCHEDULER RULE','SCHEMA','SYSTEM INDEX','SYSTEM SEQ','SYSTEM TABLE','SYSTEM VIEW','USER')";
        return (await this.rows(sql + ' ORDER BY schema, objtype, objname')).map((row) => ({
            schema: optionalText(row, 'schema') ?? 'ADMIN',
            name: text(row, 'objname'),
            objectType: text(row, 'objtype'),
            owner: optionalText(row, 'owner'),
            objectId: number(row, 'objid'),
            description: optionalText(row, 'description'),
            createdAt: optionalText(row, 'createdate'),
        }));
    }
    async searchObjects(pattern: string, schema?: string): Promise<NzObjectInfo[]> {
        const lower = pattern.toLowerCase();
        const tables = await this.getTables(schema, '%' + pattern + '%');
        const views = await this.getViews(schema);
        const procedures = await this.getProcedures(schema);
        return [
            ...tables.map((item) => ({
                schema: item.schema,
                name: item.tableName,
                objectType: 'TABLE',
                owner: item.owner,
                objectId: item.objectId,
            })),
            ...views
                .filter((item) => item.viewName.toLowerCase().includes(lower))
                .map((item) => ({
                    schema: item.schema,
                    name: item.viewName,
                    objectType: 'VIEW',
                    owner: item.owner,
                    objectId: item.objectId,
                })),
            ...procedures
                .filter((item) => item.name.toLowerCase().includes(lower))
                .map((item) => ({
                    schema: item.schema,
                    name: item.name,
                    objectType: 'PROCEDURE',
                    owner: item.owner,
                    objectId: item.objectId,
                })),
        ];
    }
    async getUsers(): Promise<NzPrincipalInfo[]> {
        return (await this.rows('SELECT username, objid FROM _v_user ORDER BY username')).map((row) => ({
            name: text(row, 'username'),
            objectId: number(row, 'objid'),
        }));
    }
    async getGroups(): Promise<NzPrincipalInfo[]> {
        return (await this.rows('SELECT groupname, objid FROM _v_group ORDER BY groupname')).map((row) => ({
            name: text(row, 'groupname'),
            objectId: number(row, 'objid'),
        }));
    }
    async getQueryHistory(limit = 100, username?: string): Promise<NzQueryHistoryInfo[]> {
        if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer');
        let sql =
            'SELECT qh_sessionid, qh_user, qh_database, qh_sql, qh_tsubmit, qh_tstart, qh_resrows FROM _v_qryhist WHERE 1=1';
        if (username !== undefined) sql += ' AND qh_user = ' + escapeLiteral(username);
        let rows: CatalogRow[];
        try {
            rows = await this.rows(sql + ' ORDER BY qh_tsubmit DESC LIMIT ' + limit);
        } catch (error) {
            if (missingRelation(error)) return [];
            throw error;
        }
        return rows.map((row) => ({
            sessionId: number(row, 'qh_sessionid'),
            username: optionalText(row, 'qh_user'),
            database: optionalText(row, 'qh_database'),
            queryText: optionalText(row, 'qh_sql'),
            submitTime: optionalText(row, 'qh_tsubmit'),
            startTime: optionalText(row, 'qh_tstart'),
            resultRows: number(row, 'qh_resrows'),
        }));
    }
    async getDetailedColumns(table: string, schema?: string): Promise<NzDetailedColumnInfo[]> {
        const target = normalizeObjectName(table, schema);
        let sql =
            'SELECT schema, attname, attnum, format_type, attnotnull, coldefault, description FROM _v_relation_column WHERE name = ' +
            escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND schema = ' + escapeLiteral(target.schema);
        const rows = await this.rows(sql + ' ORDER BY attnum');
        if (target.schema === null) requireUniqueSchema(rows, target.name);
        return rows.map((row) => ({
            schema: text(row, 'schema'),
            name: text(row, 'attname'),
            ordinal: number(row, 'attnum') ?? 0,
            typeName: text(row, 'format_type'),
            notNull: boolean(row, 'attnotnull'),
            defaultValue: optionalText(row, 'coldefault'),
            description: optionalText(row, 'description'),
        }));
    }
    async getOrganizeColumns(table: string, schema?: string): Promise<string[]> {
        const target = normalizeObjectName(table, schema);
        let sql = 'SELECT attname FROM _v_table_organize_column WHERE tablename = ' + escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND schema = ' + escapeLiteral(target.schema);
        try {
            return (await this.rows(sql + ' ORDER BY orgseqno')).map((row) => text(row, 'attname'));
        } catch (error) {
            if (missingRelation(error)) return [];
            throw error;
        }
    }
    async getTableKeys(table: string, schema?: string): Promise<NzTableKeyInfo[]> {
        const target = normalizeObjectName(table, schema);
        let sql =
            'SELECT constraintname, contype, attname, pkdatabase, pkschema, pkrelation, pkattname, updt_type, del_type' +
            ' FROM _v_relation_keydata WHERE relation = ' +
            escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND schema = ' + escapeLiteral(target.schema);
        let rows: CatalogRow[];
        try {
            rows = await this.rows(sql + ' ORDER BY constraintname, conseq');
        } catch (error) {
            if (missingRelation(error)) return [];
            throw error;
        }
        const keys = new Map<string, NzTableKeyInfo>();
        for (const row of rows) {
            const name = text(row, 'constraintname');
            let key = keys.get(name);
            if (!key) {
                const typeChar = text(row, 'contype');
                key = {
                    name,
                    typeChar,
                    keyType:
                        ({ p: 'PRIMARY KEY', u: 'UNIQUE', f: 'FOREIGN KEY' } as Record<string, string>)[typeChar] ??
                        'UNKNOWN',
                    columns: [],
                    pkDatabase: optionalText(row, 'pkdatabase'),
                    pkSchema: optionalText(row, 'pkschema'),
                    pkRelation: optionalText(row, 'pkrelation'),
                    pkColumns: [],
                    updateType: optionalText(row, 'updt_type') ?? 'NO ACTION',
                    deleteType: optionalText(row, 'del_type') ?? 'NO ACTION',
                };
                keys.set(name, key);
            }
            const column = optionalText(row, 'attname');
            const pkColumn = optionalText(row, 'pkattname');
            if (column) key.columns.push(column);
            if (pkColumn) key.pkColumns.push(pkColumn);
        }
        return [...keys.values()];
    }
    async getTableComment(table: string, schema?: string): Promise<string | null> {
        const target = normalizeObjectName(table, schema);
        let where = 'objname = ' + escapeLiteral(target.name);
        if (target.schema !== null) where += ' AND schema = ' + escapeLiteral(target.schema);
        for (const suffix of [" AND objtype = 'TABLE'", '']) {
            try {
                const rows = await this.rows('SELECT description FROM _v_object_data WHERE ' + where + suffix);
                const comment = rows.map((row) => optionalText(row, 'description')).find((value) => value?.trim());
                if (comment) return comment;
            } catch (error) {
                if (missingRelation(error)) return null;
                throw error;
            }
        }
        return null;
    }
    async getTableOwner(table: string, schema?: string): Promise<string | null> {
        const target = normalizeObjectName(table, schema);
        let sql = 'SELECT owner FROM _v_table WHERE tablename = ' + escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND schema = ' + escapeLiteral(target.schema);
        try {
            const rows = await this.rows(sql);
            return rows[0] ? optionalText(rows[0], 'owner') : null;
        } catch (error) {
            if (missingRelation(error)) return null;
            throw error;
        }
    }

    async getTableDdl(table: string, schema?: string, database?: string): Promise<string> {
        const target = normalizeObjectName(table, schema);
        const quotedTable = quoteIdentifier(target.name);
        const quotedSchema = target.schema === null ? undefined : quoteIdentifier(target.schema);
        const columns = await this.getDetailedColumns(quotedTable, quotedSchema);
        if (!columns.length) throw new Error('Table ' + target.name + ' not found');
        const actualSchema = target.schema ?? columns[0].schema;
        const distribution = await this.getDistributionKey(quotedTable, quoteIdentifier(actualSchema));
        const organization = await this.getOrganizeColumns(quotedTable, quoteIdentifier(actualSchema));
        const keys = await this.getTableKeys(quotedTable, quoteIdentifier(actualSchema));
        const comment = await this.getTableComment(quotedTable, quoteIdentifier(actualSchema));
        return buildTableDdl(
            database ?? (await this.getCurrentDatabase()) ?? 'UNKNOWN',
            actualSchema,
            target.name,
            columns as DdlColumn[],
            distribution,
            organization,
            keys,
            comment
        );
    }
    async getViewDdl(view: string, schema?: string, database?: string): Promise<string> {
        const target = normalizeObjectName(view, schema);
        let sql = 'SELECT schema, viewname, definition FROM _v_view WHERE viewname = ' + escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND schema = ' + escapeLiteral(target.schema);
        const rows = await this.rows(sql + ' ORDER BY schema, viewname');
        requireUniqueSchema(rows, target.name);
        const row = rows[0];
        if (!row) throw new Error('View ' + target.name + ' not found');
        const definition = optionalText(row, 'definition');
        if (!definition?.trim()) throw new Error('View ' + target.name + ' has no definition');
        const actualSchema = text(row, 'schema');
        const quotedView = quoteIdentifier(target.name);
        const quotedSchema = quoteIdentifier(actualSchema);
        const columns = await this.getDetailedColumns(quotedView, quotedSchema);
        const comment = await this.getTableComment(quotedView, quotedSchema);
        return buildViewDdl(
            database ?? (await this.getCurrentDatabase()) ?? 'UNKNOWN',
            actualSchema,
            target.name,
            definition,
            comment,
            columns
        );
    }
    async getProcedureDdl(procedure: string, schema?: string, database?: string): Promise<string> {
        const target = normalizeObjectName(procedure, schema);
        const column = target.name.includes('(') ? 'proceduresignature' : 'procedure';
        let sql =
            'SELECT schema, procedure, proceduresignature, arguments, returns, executedasowner,' +
            ' description, proceduresource FROM _v_procedure WHERE ' +
            column +
            ' = ' +
            escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND schema = ' + escapeLiteral(target.schema);
        const rows = await this.rows(sql + ' ORDER BY proceduresignature');
        requireUniqueSchema(rows, target.name);
        if (rows.length > 1)
            throw new Error('Procedure ' + target.name + ' has multiple overloads; pass its signature');
        const row = rows[0];
        if (!row) throw new Error('Procedure ' + target.name + ' not found');
        const info: DdlProcedure = {
            name: text(row, 'procedure'),
            signature: optionalText(row, 'proceduresignature'),
            arguments: optionalText(row, 'arguments'),
            returns: optionalText(row, 'returns') ?? 'INTEGER',
            executedAsOwner:
                row.executedasowner === null || row.executedasowner === undefined
                    ? true
                    : boolean(row, 'executedasowner'),
            description: optionalText(row, 'description'),
            source: optionalText(row, 'proceduresource') ?? '',
        };
        return buildProcedureDdl(database ?? (await this.getCurrentDatabase()) ?? 'UNKNOWN', text(row, 'schema'), info);
    }
    async getExternalTableDdl(table: string, schema?: string, database?: string): Promise<string> {
        const target = normalizeObjectName(table, schema);
        const fields = externalOptions.map((option) => 'E.' + option.column).join(', ');
        let sql =
            'SELECT E.SCHEMA, E.TABLENAME, X.EXTOBJNAME, ' +
            fields +
            ' FROM _v_external E JOIN _v_extobject X ON E.RELID = X.OBJID' +
            ' WHERE E.TABLENAME = ' +
            escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND E.SCHEMA = ' + escapeLiteral(target.schema);
        const rows = await this.rows(sql);
        requireUniqueSchema(rows, target.name);
        const row = rows[0];
        if (!row) throw new Error('External table ' + target.name + ' not found');
        const catalogLayout = row.layout ?? row.LAYOUT;
        let layoutZones: CatalogRow[] = [];
        if (isExternalLayoutZoneCount(catalogLayout)) {
            layoutZones = await this.rows(
                'SELECT Z.USETYPE, Z.NAME, Z.TYPE, Z.STYLE, Z.LENGTH, Z.DELIMITER,' +
                    ' Z.AROUND, Z.NULLIF, Z.ENDIAN, Z.ALIGNMENT, Z.MODULUS' +
                    ' FROM _v_external E JOIN _v_extzones Z ON E.RELID = Z.RELID' +
                    ' WHERE E.SCHEMA = ' +
                    escapeLiteral(text(row, 'schema')) +
                    ' AND E.TABLENAME = ' +
                    escapeLiteral(target.name) +
                    ' ORDER BY Z.ZONEID'
            );
        }
        const actualSchema = text(row, 'schema');
        const columnSql =
            'SELECT C.ATTNAME, C.FORMAT_TYPE, C.ATTNOTNULL' +
            ' FROM _v_relation_column C JOIN _v_external E ON C.OBJID = E.RELID' +
            ' WHERE E.SCHEMA = ' +
            escapeLiteral(actualSchema) +
            ' AND E.TABLENAME = ' +
            escapeLiteral(target.name) +
            ' ORDER BY C.ATTNUM';
        const columns: DdlExternalColumn[] = (await this.rows(columnSql)).map((item) => ({
            name: text(item, 'attname'),
            typeName: text(item, 'format_type'),
            notNull: boolean(item, 'attnotnull'),
        }));
        const options = new Map(Object.entries(row));
        options.set('layout', reconstructExternalLayout(catalogLayout, layoutZones));
        return buildExternalTableDdl(
            database ?? (await this.getCurrentDatabase()) ?? 'UNKNOWN',
            actualSchema,
            target.name,
            optionalText(row, 'extobjname'),
            columns,
            options
        );
    }
    async getSynonymDdl(synonym: string, schema?: string, database?: string): Promise<string> {
        const target = normalizeObjectName(synonym, schema);
        let sql =
            'SELECT schema, owner, synonym_name, refobjname, description, refdatabase, refschema' +
            ' FROM _v_synonym WHERE synonym_name = ' +
            escapeLiteral(target.name);
        if (target.schema !== null) sql += ' AND schema = ' + escapeLiteral(target.schema);
        const rows = await this.rows(sql);
        requireUniqueSchema(rows, target.name);
        const row = rows[0];
        if (!row) throw new Error('Synonym ' + target.name + ' not found');
        return buildSynonymDdl(
            database ?? (await this.getCurrentDatabase()) ?? 'UNKNOWN',
            text(row, 'schema'),
            target.name,
            text(row, 'refobjname'),
            optionalText(row, 'description'),
            optionalText(row, 'refdatabase'),
            optionalText(row, 'refschema')
        );
    }
    async getTablesDdl(schema?: string, pattern?: string, tables?: readonly string[]): Promise<NzDdlBatchResult[]> {
        return this.batchDdl('table', schema, pattern, tables);
    }
    async getViewsDdl(schema?: string, pattern?: string, views?: readonly string[]): Promise<NzDdlBatchResult[]> {
        return this.batchDdl('view', schema, pattern, views);
    }
    async getProceduresDdl(
        schema?: string,
        pattern?: string,
        procedures?: readonly string[]
    ): Promise<NzDdlBatchResult[]> {
        return this.batchDdl('procedure', schema, pattern, procedures);
    }
    private async batchDdl(
        kind: 'table' | 'view' | 'procedure',
        schema?: string,
        pattern?: string,
        names?: readonly string[]
    ): Promise<NzDdlBatchResult[]> {
        let targets: Array<{ schema: string | null; name: string }>;
        if (names) targets = names.map((name) => normalizeObjectName(name, schema));
        else {
            const [catalog, column] =
                kind === 'table'
                    ? ['_v_table', 'tablename']
                    : kind === 'view'
                      ? ['_v_view', 'viewname']
                      : ['_v_procedure', 'procedure'];
            const selectedColumn = kind === 'procedure' ? 'proceduresignature' : column;
            let sql = 'SELECT schema, ' + selectedColumn + ' FROM ' + catalog + ' WHERE ' + column + ' IS NOT NULL';
            if (schema !== undefined) sql += ' AND schema = ' + escapeLiteral(schema);
            if (pattern !== undefined) sql += ' AND ' + column + ' LIKE ' + escapeLiteral(pattern);
            targets = (await this.rows(sql + ' ORDER BY schema, ' + selectedColumn)).map((row) => ({
                schema: text(row, 'schema'),
                name: text(row, selectedColumn),
            }));
        }
        const result: NzDdlBatchResult[] = [];
        for (const target of targets) {
            try {
                const name = quoteIdentifier(target.name);
                const targetSchema = target.schema === null ? undefined : quoteIdentifier(target.schema);
                const ddl =
                    kind === 'table'
                        ? await this.getTableDdl(name, targetSchema)
                        : kind === 'view'
                          ? await this.getViewDdl(name, targetSchema)
                          : await this.getProcedureDdl(name, targetSchema);
                result.push({ schema: target.schema ?? 'UNKNOWN', name: target.name, ddl, error: null });
            } catch (error) {
                result.push({
                    schema: target.schema ?? 'UNKNOWN',
                    name: target.name,
                    ddl: '',
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return result;
    }
}
