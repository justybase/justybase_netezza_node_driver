import { NzConnection, NzDatabaseError, type NzDataReader } from '@justybase/netezza-driver';
import { XlsbWriter, XlsxWriter, type CellValue } from '@justybase/spreadsheet-tasks';
import { createWriteStream } from 'node:fs';
import { unlink, rename } from 'node:fs/promises';
import { completeSql, type CompletionCatalog, type CompletionColumn, type CompletionMetadataProvider } from './completion';
import { importToNetezza, previewImport } from './importer';
import {
  beginOperation,
  cancelOperation,
  finishOperation,
  OperationCanceledError,
  type OperationContext,
  type OperationProgress
} from './operations';
import type { NzImportPreview, NzImportPreviewResult, NzImportRequest, NzImportResult } from '../preload/api';

export interface ConnectParams {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  /** Alternative: full URI netezza://user:pass@host:port/db */
  uri?: string;
  commandTimeoutSec?: number;
}

export interface QueryOptions {
  operationId?: string;
  onProgress?: (progress: OperationProgress) => void;
  maxRows?: number;
  timeoutSec?: number;
  applyAutoLimit?: boolean;
}

export interface QueryField {
  name: string;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
}

export interface QueryOk {
  ok: true;
  resultSets: QueryResultSet[];
  statements: QueryStatement[];
  rows: Record<string, unknown>[];
  fields: QueryField[];
  rowCount: number;
  notices: string[];
  elapsedMs: number;
  truncated: boolean;
  autoLimitApplied: boolean;
  sourceSql: string;
  executedSql: string;
}

export interface QueryResultSet {
  index: number;
  rows: Record<string, unknown>[];
  fields: QueryField[];
  rowCount: number;
  notices: string[];
  truncated: boolean;
  autoLimitApplied: boolean;
}

export interface QueryStatement {
  index: number;
  rowCount: number | null;
  notices: string[];
  message?: string;
}

export interface QueryErr {
  ok: false;
  canceled?: boolean;
  message: string;
  code?: string;
  detail?: string;
  elapsedMs: number;
  sourceSql: string;
  executedSql: string;
}

export type QueryResultPayload = QueryOk | QueryErr;

let conn: NzConnection | null = null;
let connectedInfo: { host: string; database: string; user: string; port: number } | null = null;

const catalogCache = new Map<string, CompletionCatalog>();
const catalogInFlight = new Map<string, Promise<CompletionCatalog | null>>();
const columnsCache = new Map<string, ColumnNode[]>();
const columnsInFlight = new Map<string, Promise<ColumnNode[]>>();

function clearMetadataCache(): void {
  catalogCache.clear();
  catalogInFlight.clear();
  columnsCache.clear();
  columnsInFlight.clear();
}

export function isConnected(): boolean {
  return conn !== null && connectedInfo !== null;
}

export function status() {
  return { connected: isConnected(), info: connectedInfo };
}

export async function connect(params: ConnectParams): Promise<{ host: string; database: string; user: string; port: number }> {
  await disconnectQuiet();
  const timeout = params.commandTimeoutSec && params.commandTimeoutSec > 0 ? params.commandTimeoutSec : 30;

  if (params.uri && params.uri.trim().length > 0) {
    conn = new NzConnection(params.uri.trim());
  } else {
    if (!params.host || !params.database || !params.user) {
      throw new Error('Host, database and user are required.');
    }
    conn = new NzConnection({
      host: params.host.trim(),
      port: params.port || 5480,
      database: params.database.trim(),
      user: params.user.trim(),
      password: params.password ?? ''
    });
  }
  conn.commandTimeout = timeout;
  await conn.connect();

  // Extract readable info for the status pill (parse URI defensively).
  if (params.uri) {
    connectedInfo = { host: params.host || 'uri', database: params.database || '?', user: params.user || '?', port: params.port || 5480 };
    try {
      const u = new URL(params.uri.replace(/^nz:/, 'netezza:'));
      connectedInfo = {
        host: u.hostname || connectedInfo.host,
        database: decodeURIComponent(u.pathname.replace(/^\//, '')) || connectedInfo.database,
        user: decodeURIComponent(u.username) || connectedInfo.user,
        port: u.port ? Number(u.port) : 5480
      };
    } catch {
      /* keep fallback */
    }
  } else {
    connectedInfo = { host: params.host.trim(), database: params.database.trim(), user: params.user.trim(), port: params.port || 5480 };
  }
  clearMetadataCache();
  return connectedInfo;
}

export async function disconnect(): Promise<void> {
  await cancelOperation();
  await disconnectQuiet();
}

async function disconnectQuiet(): Promise<void> {
  const c = conn;
  conn = null;
  connectedInfo = null;
  clearMetadataCache();
  if (c) {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
  }
}

export async function cancel(operationId?: string): Promise<{ accepted: boolean }> {
  return { accepted: await cancelOperation(operationId) };
}

function operationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function canceledQuery(rawSql: string, sql: string, started: number): QueryErr {
  return {
    ok: false,
    canceled: true,
    message: 'Query canceled.',
    elapsedMs: Date.now() - started,
    sourceSql: rawSql,
    executedSql: sql
  };
}

function ensureConn(): NzConnection {
  if (!conn) throw new Error('Not connected. Connect to the database first.');
  return conn;
}

/** Append LIMIT only to simple SELECT/WITH without their own LIMIT — example safety rail. */
export function applyAutoLimit(sql: string, maxRows: number): { sql: string; applied: boolean } {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(trimmed)) return { sql: trimmed, applied: false };
  if (/\blimit\s+\d+/i.test(trimmed)) return { sql: trimmed, applied: false };
  return { sql: `${trimmed} LIMIT ${Math.max(1, Math.floor(maxRows))}`, applied: true };
}

function hasMultipleStatements(sql: string): boolean {
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === '-' && next === '-') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ';' && sql.slice(i + 1).trim().length > 0) return true;
  }
  return false;
}

function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return Number.isNaN(value as number) ? null : value;
  }
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'object') {
    // TimeValue {hours, minutes, ...} and similar — keep as string when it has toString
    try {
      const maybe = value as { toString?: () => string };
      if (typeof maybe.toString === 'function' && maybe.toString !== Object.prototype.toString) {
        return String(maybe.toString());
      }
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export async function runQuery(rawSql: string, opts: QueryOptions = {}): Promise<QueryResultPayload> {
  const c = ensureConn();
  const maxRows = Math.max(1, Math.floor(opts.maxRows ?? 1000));
  const started = Date.now();
  const sourceSql = rawSql.trim();
  const { sql, applied } = opts.applyAutoLimit === false || hasMultipleStatements(sourceSql)
    ? { sql: sourceSql, applied: false }
    : applyAutoLimit(sourceSql, maxRows);

  const prevTimeout = c.commandTimeout;
  const operation = beginOperation(opts.operationId || operationId('query'), 'query', opts.onProgress);
  if (opts.timeoutSec && opts.timeoutSec > 0) c.commandTimeout = opts.timeoutSec;
  operation.setCancelHandler(async () => {
    try {
      await c.cancel();
    } catch {
      // Cancellation is best effort; the reader will report the final state.
    }
  });
  operation.progress({ phase: 'query', message: 'Executing query…' });
  try {
    const cmd = c.createCommand(sql);
    if (opts.timeoutSec && opts.timeoutSec > 0) cmd.commandTimeout = opts.timeoutSec;
    const reader = await cmd.executeReader();
    try {
      const resultSets: QueryResultSet[] = [];
      const statements: QueryStatement[] = [];
      let statementIndex = 0;
      let resultIndex = 0;
      let noticeCursor = 0;

      do {
        operation.checkCanceled();
        const fields: QueryField[] = (reader.columnDescriptions || []).map((col) => ({
          name: col.name,
          dataTypeID: col.typeOid,
          dataTypeSize: col.typeLen,
          dataTypeModifier: col.typeMod
        }));
        const rows: Record<string, unknown>[] = [];
        const names = (reader.columnDescriptions || []).map((col) => col.name);
        let truncated = false;
        while (await reader.read()) {
          operation.checkCanceled();
          if (fields.length > 0 && rows.length < maxRows) {
            const obj: Record<string, unknown> = {};
            for (let i = 0; i < names.length; i++) {
              obj[names[i]] = toJsonSafe(reader.getValue(i));
            }
            rows.push(obj);
          } else if (fields.length > 0) {
            truncated = true;
          }
        }

        const noticesNow = [...cmd.notices];
        const notices = noticesNow.slice(noticeCursor);
        noticeCursor = noticesNow.length;
        const rowCount = fields.length > 0
          ? rows.length
          : (cmd._recordsAffected >= 0 ? cmd._recordsAffected : null);
        statements.push({ index: statementIndex++, rowCount, notices });
        if (fields.length > 0) {
          resultSets.push({
            index: resultIndex++,
            rows,
            fields,
            rowCount: rows.length,
            notices,
            truncated: truncated && !applied,
            autoLimitApplied: applied
          });
        }
      } while (await reader.nextResult());

      operation.checkCanceled();

      const notices = [...cmd.notices];
      const first = resultSets[0];
      return {
        ok: true,
        resultSets,
        statements,
        rows: first?.rows ?? [],
        fields: first?.fields ?? [],
        rowCount: first?.rowCount ?? statements[0]?.rowCount ?? 0,
        notices,
        elapsedMs: Date.now() - started,
        truncated: first?.truncated ?? false,
        autoLimitApplied: first?.autoLimitApplied ?? false,
        sourceSql,
        executedSql: sql
      };
    } finally {
      await reader.close();
    }
  } catch (err) {
    const elapsedMs = Date.now() - started;
    if (operation.canceled || err instanceof OperationCanceledError) {
      return canceledQuery(sourceSql, sql, started);
    }
    if (err instanceof NzDatabaseError) {
      return { ok: false, message: err.message, code: err.code, detail: err.detail, elapsedMs, sourceSql, executedSql: sql };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err), elapsedMs, sourceSql, executedSql: sql };
  } finally {
    c.commandTimeout = prevTimeout;
    finishOperation(operation.id);
  }
}

// ---------------------------------------------------------------------------
// Schema browser.
// Proven pattern (mirrors the JustyBase VS Code extension for Netezza):
// system views are qualified per-database as DB.._V_xxx (i.e. DB.ADMIN._V_xxx)
// and filtered with DBNAME = '<db>' — unqualified _V_SCHEMA etc. do not
// resolve reliably. Columns: _V_SCHEMA(SCHEMA), _V_OBJECT_DATA(OBJNAME,
// OBJTYPE, SCHEMA, DBNAME), _V_RELATION_COLUMN(ATTNAME, FORMAT_TYPE).
// ---------------------------------------------------------------------------

export interface ColumnNode {
  name: string;
  type: string;
}
export interface SchemaObjectNode {
  name: string;
  kind: string;
  columns: ColumnNode[];
}
export interface SchemaNode {
  name: string;
  objects: SchemaObjectNode[];
}

interface LoadedCatalog {
  catalog: CompletionCatalog;
  schemaTree: SchemaNode[];
  warning?: string;
}

async function tryQuery(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] } | null> {
  try {
    const c = ensureConn();
    const res = await c.query(sql, params);
    return { rows: res.rows as Record<string, unknown>[] };
  } catch (err) {
    console.error('[schema] query failed:', sql, err instanceof Error ? err.message : err);
    return null;
  }
}

function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()];
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  return '';
}

/** Quote a database name for the DB..VIEW qualifier (DB.ADMIN.VIEW shortcut). */
function quoteDbIdent(name: string): string {
  const v = name.trim();
  if (/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(v)) return v.toUpperCase();
  return `"${v.replace(/"/g, '""')}"`;
}

function qualifyView(db: string, view: string): string {
  return `${quoteDbIdent(db)}..${view}`;
}

function escapeLit(v: string): string {
  return v.replace(/'/g, "''");
}

/** Case-insensitive equality (catalog stores unquoted names uppercased). */
function eqI(col: string, val: string): string {
  return `UPPER(${col}) = UPPER('${escapeLit(val)}')`;
}

function connectedDb(): string | null {
  return connectedInfo ? connectedInfo.database : null;
}

function metadataKey(...parts: (string | undefined)[]): string {
  return parts.map((part) => (part ?? '').trim().toUpperCase()).join('\u001f');
}

function normalizeObjectKind(value: string): string {
  return value.trim().replace(/[\s_-]+/g, ' ').toUpperCase() || 'OTHER';
}

function isRelationObject(kind: string): boolean {
  return ['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'EXTERNAL TABLE', 'SYNONYM'].includes(kind);
}

async function loadCatalog(database: string): Promise<LoadedCatalog> {
  const db = database.trim();
  const warnings: string[] = [];

  // 1) Schemas from DB-qualified _V_SCHEMA, fallback to DISTINCT SCHEMA.
  let schemaNames: string[] = [];
  const fromSchema = await tryQuery(`SELECT SCHEMA AS name FROM ${qualifyView(db, '_V_SCHEMA')} ORDER BY 1 LIMIT 500`);
  if (fromSchema) {
    for (const r of fromSchema.rows) {
      const name = pick(r, 'name', 'SCHEMA', 'schema');
      if (name) schemaNames.push(name);
    }
  } else {
    warnings.push('Could not read _V_SCHEMA.');
  }
  if (schemaNames.length === 0) {
    const fallback = await tryQuery(
      `SELECT DISTINCT SCHEMA AS name FROM ${qualifyView(db, '_V_OBJECT_DATA')} WHERE ${eqI('DBNAME', db)} ORDER BY 1 LIMIT 500`
    );
    if (fallback) {
      for (const r of fallback.rows) {
        const name = pick(r, 'name', 'SCHEMA', 'schema');
        if (name) schemaNames.push(name);
      }
      if (schemaNames.length > 0) warnings.push('Schemas listed via _V_OBJECT_DATA (fallback).');
    }
  }
  schemaNames = [...new Set(schemaNames)].sort().slice(0, 200);
  if (schemaNames.length === 0) {
    return {
      catalog: { database: db, schemas: [] },
      schemaTree: [],
      warning: 'No schemas found. Check SELECT rights on the catalog or run a query manually.'
    };
  }

  // 2) All object types per schema via DB-qualified _V_OBJECT_DATA.
  // Keep relations in CompletionCatalog for SQL completion, while retaining
  // every catalog object for the schema browser.
  const schemas: CompletionCatalog['schemas'] = [];
  const schemaTree: SchemaNode[] = [];
  for (const schema of schemaNames.slice(0, 60)) {
    const objs = await tryQuery(
      `SELECT OBJNAME AS name, OBJTYPE AS type FROM ${qualifyView(db, '_V_OBJECT_DATA')} ` +
        `WHERE ${eqI('DBNAME', db)} AND ${eqI('SCHEMA', schema)} ` +
        `ORDER BY 2, 1 LIMIT 2000`
    );
    if (!objs) {
      warnings.push(`Cannot list objects in schema ${schema}.`);
      schemas.push({ name: schema, tables: [] });
      schemaTree.push({ name: schema, objects: [] });
      continue;
    }
    // _V_OBJECT_DATA exposes the object type, while _V_PROCEDURE keeps the
    // callable signature. Use the latter when available so overloaded
    // procedures do not collapse into one indistinguishable browser entry.
    const procedureDetails = await tryQuery(
      `SELECT PROCEDURESIGNATURE AS name, 'PROCEDURE' AS type FROM ${qualifyView(db, '_V_PROCEDURE')} ` +
        `WHERE ${eqI('DATABASE', db)} AND ${eqI('SCHEMA', schema)} ` +
        `ORDER BY 1 LIMIT 1000`
    );
    const objectRows = procedureDetails
      ? [
          ...objs.rows.filter((row) => normalizeObjectKind(pick(row, 'type', 'OBJTYPE', 'objtype')) !== 'PROCEDURE'),
          ...procedureDetails.rows
        ]
      : objs.rows;
    const tables: CompletionCatalog['schemas'][number]['tables'] = [];
    const objects: SchemaObjectNode[] = [];
    const seen = new Set<string>();
    for (const r of objectRows) {
      const name = pick(r, 'name', 'OBJNAME', 'objname');
      if (!name) continue;
      const kind = normalizeObjectKind(pick(r, 'type', 'OBJTYPE', 'objtype'));
      const key = `${kind}\u001f${name.toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      objects.push({ name, kind, columns: [] });
      if (isRelationObject(kind)) {
        tables.push({ name, kind: kind === 'VIEW' || kind === 'MATERIALIZED VIEW' ? 'VIEW' : 'TABLE', schema, columns: [] });
      }
    }
    schemas.push({ name: schema, tables: tables.slice(0, 1000) });
    schemaTree.push({ name: schema, objects: objects.slice(0, 2000) });
  }

  return {
    catalog: { database: db, schemas },
    schemaTree,
    warning: warnings.length > 0 ? warnings.join(' ') : undefined
  };
}

export async function getCatalog(database: string): Promise<CompletionCatalog | null> {
  const db = database.trim();
  if (!db || !isConnected()) return null;
  const key = metadataKey(db);
  const cached = catalogCache.get(key);
  if (cached) return cached;
  const inFlight = catalogInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = loadCatalog(db)
    .then(({ catalog }) => {
      catalogCache.set(key, catalog);
      return catalog;
    })
    .catch((err) => {
      console.error('[completion] catalog query failed:', err instanceof Error ? err.message : err);
      return null;
    })
    .finally(() => catalogInFlight.delete(key));
  catalogInFlight.set(key, promise);
  return promise;
}

export async function getSchemaTree(): Promise<{ schemas: SchemaNode[]; warning?: string }> {
  const db = connectedDb();
  if (!db) return { schemas: [], warning: 'Not connected.' };
  const loaded = await loadCatalog(db);
  catalogCache.set(metadataKey(db), loaded.catalog);
  return {
    schemas: loaded.schemaTree,
    warning: loaded.warning
  };
}

export async function getObjectDefinition(
  schema: string,
  name: string,
  kind: 'VIEW' | 'PROCEDURE',
  database = connectedDb() ?? ''
): Promise<{ ok: true; content: string } | { ok: false; message: string }> {
  const db = database.trim();
  const objectName = name.trim();
  const schemaName = schema.trim();
  if (!db || !schemaName || !objectName || !isConnected()) {
    return { ok: false, message: 'Connect to the database before opening an object definition.' };
  }

  if (kind === 'VIEW') {
    const result = await tryQuery(
      `SELECT DEFINITION AS definition FROM ${qualifyView(db, '_V_VIEW')} ` +
        `WHERE ${eqI('DATABASE', db)} AND ${eqI('SCHEMA', schemaName)} AND ${eqI('VIEWNAME', objectName)} LIMIT 1`
    );
    const definition = result?.rows[0] ? pick(result.rows[0], 'definition', 'DEFINITION') : '';
    return definition
      ? { ok: true, content: definition }
      : { ok: false, message: `Definition for view ${schemaName}.${objectName} was not found.` };
  }

  const procedureBaseName = objectName.replace(/\s*\(.*/, '').trim();
  const procedurePredicate = objectName.includes('(')
    ? ` AND (${eqI('PROCEDURESIGNATURE', objectName)} OR ${eqI('PROCEDURE', procedureBaseName)})`
    : ` AND ${eqI('PROCEDURE', objectName)}`;
  const result = await tryQuery(
    `SELECT PROCEDURESIGNATURE AS signature, RESULT AS returns, PROCEDURESOURCE AS source ` +
      `FROM ${qualifyView(db, '_V_PROCEDURE')} ` +
      `WHERE ${eqI('DATABASE', db)} AND ${eqI('SCHEMA', schemaName)}${procedurePredicate} LIMIT 1`
  );
  const row = result?.rows[0];
  const source = row ? pick(row, 'source', 'PROCEDURESOURCE') : '';
  const signature = row ? pick(row, 'signature', 'PROCEDURESIGNATURE') : '';
  const returns = row ? pick(row, 'returns', 'RETURNS') : '';
  const metadata = [
    `-- ${schemaName}.${objectName}`,
    signature ? `-- Signature: ${signature}` : '',
    returns ? `-- Returns: ${returns}` : ''
  ].filter(Boolean).join('\n');
  return source
    ? { ok: true, content: `${metadata}\n\n${source}` }
    : { ok: false, message: `Source for procedure ${schemaName}.${objectName} was not found.` };
}

async function loadColumns(database: string, schema: string | undefined, table: string): Promise<ColumnNode[]> {
  const db = database.trim();
  if (!db || !table.trim() || !isConnected()) return [];
  // Proven join: relation columns linked to the object via OBJID.
  const schemaPredicate = schema ? ` AND ${eqI('D.SCHEMA', schema)}` : '';
  const sql =
    `SELECT X.ATTNAME AS name, X.FORMAT_TYPE AS type FROM ${qualifyView(db, '_V_RELATION_COLUMN')} X ` +
    `INNER JOIN ${qualifyView(db, '_V_OBJECT_DATA')} D ON X.OBJID = D.OBJID ` +
    `WHERE ${eqI('D.OBJNAME', table)} AND ${eqI('D.DBNAME', db)}${schemaPredicate} ` +
    `ORDER BY X.ATTNUM LIMIT 500`;
  const res = await tryQuery(sql);
  if (res && res.rows.length > 0) {
    return res.rows.map((r) => ({ name: pick(r, 'name', 'ATTNAME'), type: pick(r, 'type', 'FORMAT_TYPE') || 'UNKNOWN' }));
  }
  // Fallback: zero-row SELECT + metadata (works whenever we have SELECT grant).
  try {
    const c = ensureConn();
    const qualifiedTable = schema
      ? `${quoteDbIdent(db)}."${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`
      : `${quoteDbIdent(db)}.."${table.replace(/"/g, '""')}"`;
    const reader = await c.createCommand(`SELECT * FROM ${qualifiedTable} LIMIT 0`).executeReader();
    try {
      const cols: ColumnNode[] = [];
      for (let i = 0; i < reader.fieldCount; i++) {
        try {
          cols.push({ name: reader.getName(i), type: reader.getDeclaredTypeName(i) });
        } catch {
          cols.push({ name: reader.getName(i), type: 'UNKNOWN' });
        }
      }
      return cols;
    } finally {
      await reader.close();
    }
  } catch {
    return [];
  }
}

export async function getColumns(schema: string | undefined, table: string, database = connectedDb() ?? ''): Promise<ColumnNode[]> {
  const db = database.trim();
  if (!db) return [];
  const key = metadataKey(db, schema, table);
  const cached = columnsCache.get(key);
  if (cached) return cached;
  const inFlight = columnsInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = loadColumns(db, schema, table)
    .then((columns) => {
      columnsCache.set(key, columns);
      return columns;
    })
    .finally(() => columnsInFlight.delete(key));
  columnsInFlight.set(key, promise);
  return promise;
}

export async function previewImportFile(
  request: { operationId: string; filePath: string; sheetName?: string; hasHeader?: boolean; delimiter?: string },
  onProgress?: (progress: OperationProgress) => void
): Promise<NzImportPreviewResult> {
  const operation = beginOperation(request.operationId || operationId('import-preview'), 'import-preview', onProgress);
  try {
    operation.progress({ phase: 'preview', message: 'Reading file preview…' });
    return await previewImport(request, operation);
  } catch (error) {
    if (operation.canceled || error instanceof OperationCanceledError) {
      return { ok: false, canceled: true, message: 'Import preview canceled.' };
    }
    throw error;
  } finally {
    finishOperation(operation.id);
  }
}

function importTargetParts(targetTable: string): { database?: string; schema?: string; table: string } {
  const parts = targetTable.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 3) throw new Error('Target table must be TABLE, SCHEMA.TABLE or DATABASE.SCHEMA.TABLE.');
  return {
    database: parts.length === 3 ? parts[0] : undefined,
    schema: parts.length >= 2 ? parts[parts.length - 2] : undefined,
    table: parts[parts.length - 1]
  };
}

export async function importFile(
  request: NzImportRequest,
  onProgress: (progress: OperationProgress) => void
): Promise<NzImportResult> {
  const c = ensureConn();
  const database = connectedDb() ?? '';
  const operation = beginOperation(request.operationId || operationId('import'), 'import', onProgress);
  operation.setCancelHandler(async () => {
    try {
      await c.cancel();
    } catch {
      // Cancellation is best effort.
    }
  });
  try {
    let targetColumns: ColumnNode[] | undefined;
    if (request.mode === 'append') {
      const target = importTargetParts(request.targetTable);
      targetColumns = await getColumns(target.schema, target.table, target.database || database);
      operation.checkCanceled();
    }
    return await importToNetezza(c, database, request, targetColumns, operation);
  } catch (error) {
    if (operation.canceled || error instanceof OperationCanceledError) {
      return { ok: false, canceled: true, message: 'Import canceled.', format: request.format };
    }
    throw error;
  } finally {
    finishOperation(operation.id);
  }
}

function excelValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`;
  return String(value);
}

export async function exportQueryToExcel(
  rawSql: string,
  outputPath: string,
  format: 'xlsx' | 'xlsb',
  timeoutSec?: number,
  resultSetIndex = 0,
  operationIdValue?: string,
  onProgress?: (progress: OperationProgress) => void
): Promise<{ rowsExported: number; columns: number } | { canceled: true }> {
  const c = ensureConn();
  const sql = rawSql.trim().replace(/;+\s*$/, '');
  if (!sql) throw new Error('Enter a SQL query before exporting.');
  const tempPath = `${outputPath}.part-${process.pid}-${Date.now()}.${format}`;
  const previousTimeout = c.commandTimeout;
  const operation = beginOperation(operationIdValue || operationId('export-excel'), 'export-excel', onProgress);
  operation.setCancelHandler(async () => {
    try {
      await c.cancel();
    } catch {
      // Cancellation is best effort; reader cleanup happens in finally.
    }
  });
  let reader: NzDataReader | null = null;
  let writer: XlsbWriter | XlsxWriter | null = null;
  let writerFinalized = false;
  try {
    if (timeoutSec && timeoutSec > 0) c.commandTimeout = timeoutSec;
    operation.progress({ phase: 'export', message: `Starting ${format.toUpperCase()} export…`, rows: 0 });
    const command = c.createCommand(sql);
    if (timeoutSec && timeoutSec > 0) command.commandTimeout = timeoutSec;
    const activeReader = await command.executeReader();
    reader = activeReader;
    writer = format === 'xlsb' ? new XlsbWriter(tempPath) : new XlsxWriter(tempPath);
    let rowsExported = 0;
    let resultIndex = 0;
    let found = false;
    let columns = 0;

    do {
      operation.checkCanceled();
      const headers = (reader.columnDescriptions || []).map((column) => column.name);
      if (headers.length > 0) {
        const shouldWrite = resultIndex === Math.max(0, Math.floor(resultSetIndex));
        if (shouldWrite) {
          found = true;
          columns = headers.length;
          writer.startSheet('Results', headers.length, headers, { doAutofilter: true });
        }
        while (await reader.read()) {
          operation.checkCanceled();
          if (shouldWrite) {
            const row: CellValue[] = [];
            for (let i = 0; i < headers.length; i++) row.push(excelValue(reader.getValue(i)));
            writer.writeRow(row);
            rowsExported++;
            if (rowsExported === 1 || rowsExported % 1000 === 0) {
              operation.progress({ phase: 'export', message: `Exported ${rowsExported.toLocaleString()} rows`, rows: rowsExported });
            }
          }
        }
        if (shouldWrite) writer.endSheet();
        resultIndex++;
      } else {
        while (await reader.read()) {
          // Drain non-row result sets so the protocol is ready for nextResult().
        }
      }
    } while (await reader.nextResult());

    operation.checkCanceled();
    if (!found) throw new Error(`Result set ${Math.max(1, resultSetIndex + 1)} returned no columns.`);
    await writer.finalize();
    writerFinalized = true;
    operation.checkCanceled();
    await rename(tempPath, outputPath);
    operation.progress({ phase: 'export', message: `${format.toUpperCase()} export completed`, rows: rowsExported, percent: 100 });
    return { rowsExported, columns };
  } catch (err) {
    if (writer && !writerFinalized) {
      await writer.finalize().catch(() => undefined);
      writerFinalized = true;
    }
    try {
      await unlink(tempPath);
    } catch {
      /* no partial file to remove */
    }
    if (operation.canceled || err instanceof OperationCanceledError) return { canceled: true };
    throw err;
  } finally {
    if (reader) await reader.close().catch(() => undefined);
    c.commandTimeout = previousTimeout;
    finishOperation(operation.id);
  }
}

export async function getCompletionItems(sql: string, offset: number): Promise<{ items: import('./completion').CompletionItem[] }> {
  const activeDatabase = connectedDb();
  if (!activeDatabase) return { items: [] };
  const provider: CompletionMetadataProvider = {
    getCatalog,
    getColumns: async (database, schema, table) => getColumns(schema, table, database)
  };
  return completeSql(sql, offset, activeDatabase, provider);
}

export function toCsv(rows: Record<string, unknown>[], fields: QueryField[]): string {
  const header = fields.map((f) => f.name);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(';')];
  for (const row of rows) lines.push(header.map((h) => esc(row[h])).join(';'));
  return lines.join('\r\n');
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeCsvChunk(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string,
  operation: OperationContext,
  getStreamError: () => Error | null
): Promise<void> {
  operation.checkCanceled();
  const streamError = getStreamError();
  if (streamError) throw streamError;
  if (stream.write(chunk, 'utf8')) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(getStreamError() || new OperationCanceledError());
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
  operation.checkCanceled();
}

async function finishCsvStream(
  stream: ReturnType<typeof createWriteStream>,
  operation: OperationContext,
  getStreamError: () => Error | null
): Promise<void> {
  const streamError = getStreamError();
  if (streamError) throw streamError;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener('finish', onFinish);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(getStreamError() || new OperationCanceledError());
    };
    stream.once('finish', onFinish);
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.end();
  });
  operation.checkCanceled();
}

async function closeCsvStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolve) => {
    stream.once('close', () => resolve());
    stream.destroy();
  });
}

export async function exportRowsToCsv(
  rows: Record<string, unknown>[],
  fields: { name: string }[],
  outputPath: string,
  operationIdValue?: string,
  onProgress?: (progress: OperationProgress) => void
): Promise<{ rowsExported: number } | { canceled: true }> {
  const operation = beginOperation(operationIdValue || operationId('export-csv'), 'export-csv', onProgress);
  const tempPath = `${outputPath}.part-${process.pid}-${Date.now()}.csv`;
  let stream: ReturnType<typeof createWriteStream> | undefined;
  let streamError: Error | null = null;
  operation.setCancelHandler(() => {
    stream?.destroy();
  });
  try {
    stream = createWriteStream(tempPath, { encoding: 'utf8' });
    stream.on('error', (error) => {
      streamError = error instanceof Error ? error : new Error(String(error));
    });
    const getStreamError = () => streamError;
    const headers = fields.map((field) => field.name);
    await writeCsvChunk(stream, `\uFEFF${headers.map(csvCell).join(';')}\r\n`, operation, getStreamError);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      await writeCsvChunk(stream, `${headers.map((header) => csvCell(row[header])).join(';')}\r\n`, operation, getStreamError);
      if (index === 0 || (index + 1) % 100 === 0) {
        operation.progress({ phase: 'export', message: `Exported ${(index + 1).toLocaleString()} rows`, rows: index + 1, percent: rows.length > 0 ? Math.round((index + 1) / rows.length * 100) : 100 });
      }
    }
    await finishCsvStream(stream, operation, getStreamError);
    await rename(tempPath, outputPath);
    operation.progress({ phase: 'export', message: 'CSV export completed', rows: rows.length, percent: 100 });
    return { rowsExported: rows.length };
  } catch (error) {
    if (stream) await closeCsvStream(stream);
    await unlink(tempPath).catch(() => undefined);
    if (operation.canceled || error instanceof OperationCanceledError) return { canceled: true };
    throw error;
  } finally {
    if (stream && !stream.closed) await closeCsvStream(stream);
    finishOperation(operation.id);
  }
}
