import { NzConnection } from '@justybase/netezza-driver';
import { ReaderFactory } from '@justybase/spreadsheet-tasks';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { OperationCanceledError, type OperationContext } from './operations.ts';
import type {
  NzImportColumn,
  NzImportPreview,
  NzImportRequest,
  NzImportResult,
  ImportFileFormat
} from '../preload/api';

const MAX_SAMPLE_ROWS = 24;
const TYPE_SAMPLE_ROWS = 1000;
const SAFE_TYPE = /^[A-Za-z][A-Za-z0-9 ]*(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?$/;
const MAX_RECORD_SIZE = 65535;
const SAFE_RECORD_SIZE = 60000;

interface SheetReader {
  fieldCount: number;
  read(): Promise<boolean>;
  getSheetNames(): string[];
  getValue(index: number): unknown;
  open(filePath: string): Promise<void>;
  close(): Promise<void>;
}

interface SheetReaderInternals {
  _currentRow?: unknown[];
  _currentSheetIndex?: number;
  _initSheet?: (index: number) => Promise<void>;
}

interface ImportTargetColumn {
  name: string;
  type: string;
}

function fileFormat(filePath: string): ImportFileFormat {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.xlsx') return 'xlsx';
  if (extension === '.xlsb') return 'xlsb';
  if (extension === '.csv') return 'csv';
  throw new Error('Unsupported file format. Choose a CSV, XLSX or XLSB file.');
}

function cleanIdentifier(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  if (!cleaned || /^\d/.test(cleaned)) return fallback;
  return cleaned;
}

function uniqueIdentifiers(values: string[]): string[] {
  const used = new Set<string>();
  return values.map((value, index) => {
    const base = cleanIdentifier(value, `COL_${index + 1}`);
    let candidate = base;
    let suffix = 1;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate);
    return candidate;
  });
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  }
  return String(value);
}

function detectDelimiter(content: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const delimiter of candidates) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (char === '"') {
        if (quoted && content[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted && char === delimiter) {
        count++;
      } else if (!quoted && (char === '\n' || char === '\r')) {
        break;
      }
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

async function csvDelimiter(filePath: string, requested?: string): Promise<string> {
  if (requested && requested.length > 0) return requested;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let sample = '';
  for await (const chunk of stream) {
    sample += String(chunk);
    if (sample.length >= 64 * 1024) break;
  }
  stream.destroy();
  return detectDelimiter(sample.replace(/^\uFEFF/, ''));
}

async function* readCsvRows(filePath: string, delimiter: string): AsyncGenerator<string[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let pendingQuote = false;
  let skipLf = false;
  let firstCharacter = true;

  const emit = (): string[] | null => {
    row.push(field);
    field = '';
    const result = row;
    row = [];
    if (result.length === 1 && result[0].trim() === '') return null;
    if (result[0]?.startsWith('\uFEFF')) result[0] = result[0].slice(1);
    return result;
  };

  for await (const chunk of stream) {
    const text = String(chunk);
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (skipLf && char === '\n') {
        skipLf = false;
        continue;
      }
      skipLf = false;

      if (pendingQuote) {
        pendingQuote = false;
        if (char === '"') {
          field += '"';
          continue;
        }
        inQuotes = false;
      }

      if (inQuotes) {
        if (char === '"') pendingQuote = true;
        else field += char;
        continue;
      }

      if (char === '"' && (firstCharacter || field.length === 0)) {
        inQuotes = true;
        firstCharacter = false;
      } else if (char === delimiter) {
        row.push(field);
        field = '';
        firstCharacter = true;
      } else if (char === '\n' || char === '\r') {
        if (char === '\r') skipLf = true;
        const emitted = emit();
        firstCharacter = true;
        if (emitted) yield emitted;
      } else {
        field += char;
        firstCharacter = false;
      }
    }
  }

  if (pendingQuote) inQuotes = false;
  if (field.length > 0 || row.length > 0) {
    const emitted = emit();
    if (emitted) yield emitted;
  }
}

async function excelSheetNames(filePath: string): Promise<string[]> {
  const reader = ReaderFactory.create(filePath) as unknown as SheetReader;
  try {
    await reader.open(filePath);
    return [...reader.getSheetNames()];
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function* readExcelRows(filePath: string, sheetName?: string): AsyncGenerator<string[]> {
  const reader = ReaderFactory.create(filePath) as unknown as SheetReader;
  const internal = reader as unknown as SheetReaderInternals;
  try {
    await reader.open(filePath);
    const sheets = reader.getSheetNames();
    const selectedIndex = sheetName ? sheets.findIndex((name) => name === sheetName) : 0;
    if (sheetName && selectedIndex < 0) throw new Error(`Worksheet not found: ${sheetName}`);
    if (selectedIndex > 0) {
      internal._currentSheetIndex = selectedIndex;
      await internal._initSheet?.(selectedIndex);
    }

    while (await reader.read()) {
      const current = internal._currentRow;
      const width = Math.max(reader.fieldCount || 0, current?.length || 0);
      const values: string[] = [];
      for (let index = 0; index < width; index++) {
        values.push(textValue(current?.[index] ?? reader.getValue(index)));
      }
      if (values.some((value) => value.trim().length > 0)) yield values;
    }
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function* readSourceRows(filePath: string, format: ImportFileFormat, delimiter?: string, sheetName?: string): AsyncGenerator<string[]> {
  if (format === 'csv') {
    yield* readCsvRows(filePath, delimiter || ',');
  } else {
    yield* readExcelRows(filePath, sheetName);
  }
}

function looksNumeric(value: string): boolean {
  return /^[-+]?\d+(?:[.,]\d+)?$/.test(value.trim());
}

function looksBoolean(value: string): boolean {
  return /^(true|false|yes|no)$/i.test(value.trim());
}

function looksDate(value: string): boolean {
  return /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})$/.test(value.trim());
}

function looksTimestamp(value: string): boolean {
  return /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}[T ]\d{1,2}:\d{2}/.test(value.trim());
}

function inferType(values: string[]): string {
  const nonEmpty = values.map((value) => value.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return 'NVARCHAR(255)';
  if (nonEmpty.every(looksBoolean)) return 'BOOLEAN';
  if (nonEmpty.every((value) => /^[-+]?\d+$/.test(value))) return 'BIGINT';
  if (nonEmpty.every(looksNumeric)) return 'NUMERIC(18,2)';
  if (nonEmpty.every(looksTimestamp)) return 'TIMESTAMP';
  if (nonEmpty.every(looksDate)) return 'DATE';
  const longest = Math.max(...nonEmpty.map((value) => value.length));
  return longest > 1024 ? 'NVARCHAR(4000)' : longest > 255 ? 'NVARCHAR(1024)' : 'NVARCHAR(255)';
}

function autoHeader(row: string[]): boolean {
  const values = row.map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return false;
  if (new Set(values.map((value) => value.toUpperCase())).size !== values.length) return false;
  return values.every((value) => !looksNumeric(value) && !looksBoolean(value) && !looksDate(value));
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeType(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!SAFE_TYPE.test(normalized)) throw new Error(`Invalid Netezza type: ${value}`);
  return normalized;
}

function quoteTarget(target: string): { sql: string; schema?: string; table: string; database?: string } {
  const parts = target.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 3) throw new Error('Target table must be TABLE, SCHEMA.TABLE or DATABASE.SCHEMA.TABLE.');
  const table = parts[parts.length - 1];
  const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  const database = parts.length === 3 ? parts[0] : undefined;
  return { sql: parts.map(quoteIdentifier).join('.'), schema, table, database };
}

function externalValue(value: string, type: string): string {
  let result = value.trim();
  if (!result) return '';
  const base = type.split('(')[0];
  if (base === 'NUMERIC' || base === 'DECIMAL') result = result.replace(',', '.');
  if (base === 'DATE' || base === 'TIMESTAMP') {
    const date = result.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(.*)$/);
    if (date) result = `${date[3]}-${date[2].padStart(2, '0')}-${date[1].padStart(2, '0')}${date[4] || ''}`;
    result = result.replace('T', ' ');
  }
  if (base === 'BOOLEAN') {
    if (/^(true|yes)$/i.test(result)) result = '1';
    if (/^(false|no)$/i.test(result)) result = '0';
  }
  return result
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function externalUsingClause(): string {
  const logDir = join(tmpdir(), 'netezza-sql-editor-import-logs').replace(/\\/g, '/');
  return `USING ( REMOTESOURCE 'jdbc' DELIMITER '\\t' RecordDelim '\\n' ESCAPECHAR '\\' NULLVALUE '' ENCODING 'Utf-8' TIMESTYLE '24hour' BOOLSTYLE '1_0' SKIPROWS 0 MAXERRORS 1 COMPRESS FALSE LOGDIR '${logDir}' )`;
}

function baseType(type: string): string {
  return type.split('(')[0].trim().toUpperCase();
}

function textWidth(type: string): number | null {
  const match = type.match(/\((\d+)\)/);
  return match ? Number(match[1]) : null;
}

function textTypeForLength(type: string, maxLength: number): string {
  const base = baseType(type);
  if (base !== 'VARCHAR' && base !== 'NVARCHAR' && base !== 'CHAR' && base !== 'NCHAR') return type;
  return `${base === 'CHAR' || base === 'NCHAR' ? 'NVARCHAR' : base}(${Math.max(1, Math.min(4000, maxLength || 1))})`;
}

export function externalTypeForColumn(type: string, maxLength: number): string {
  switch (baseType(type)) {
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'DATE':
      return 'DATE';
    case 'TIMESTAMP':
    case 'DATETIME':
      return 'TIMESTAMP';
    case 'INTEGER':
    case 'BIGINT':
    case 'SMALLINT':
    case 'NUMERIC':
    case 'DECIMAL':
    case 'DOUBLE':
    case 'REAL':
      return type;
    default:
      // Netezza does not allow CHAR/VARCHAR external columns together with
      // ENCODING 'Utf-8'. NVARCHAR is the unicode-compatible external type;
      // the SELECT cast below still converts it to the requested target type.
      return `NVARCHAR(${Math.max(1, Math.min(4000, maxLength || textWidth(type) || 1))})`;
  }
}

function declaredWidth(type: string): number {
  const width = textWidth(type);
  if (width !== null && ['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR'].includes(baseType(type))) return width;
  return 16;
}

function validateRecordSize(columns: Array<{ type: string; externalType: string }>): void {
  const targetWidth = columns.reduce((total, column) => total + declaredWidth(column.type), 0);
  const externalWidth = columns.reduce((total, column) => total + declaredWidth(column.externalType), 0);
  if (targetWidth > MAX_RECORD_SIZE) {
    throw new Error(`The imported table would have a record size of ${targetWidth} bytes, exceeding Netezza's ${MAX_RECORD_SIZE}-byte limit. Reduce wide text columns or split the file.`);
  }
  if (externalWidth > SAFE_RECORD_SIZE) {
    throw new Error(`The import source record is ${externalWidth} bytes wide, exceeding the safe Netezza limit. Reduce wide text columns or split the file.`);
  }
}

function externalColumns(columns: Array<{ sourceName: string; externalType: string }>): string {
  return columns.map((column) => `    ${quoteIdentifier(column.sourceName)} ${column.externalType}`).join(',\n');
}

function castColumn(sourceName: string, outputName: string, type: string): string {
  return `CAST(${quoteIdentifier(sourceName)} AS ${type}) AS ${quoteIdentifier(outputName)}`;
}

export function buildImportSql(
  request: NzImportRequest,
  targetColumns: ImportTargetColumn[] | undefined,
  virtualFileName: string,
  sourceColumns: Array<{ sourceIndex: number; sourceName: string; outputName: string; type: string; externalType: string }>
): string {
  const target = quoteTarget(request.targetTable);
  const external = externalColumns(sourceColumns);
  const resolvedTargets = sourceColumns.map((column) => {
    const targetColumn = targetColumns?.find((candidate) => candidate.name.toUpperCase() === column.outputName.toUpperCase());
    return targetColumn || { name: column.outputName, type: column.type };
  });
  const expressions = sourceColumns.map((column, index) => {
    const targetColumn = resolvedTargets[index];
    const outputName = targetColumn?.name || column.outputName;
    const outputType = normalizeType(targetColumn?.type || column.type);
    return castColumn(column.sourceName, outputName, outputType);
  });

  if (request.mode === 'append') {
    const targetNames = resolvedTargets.map((column) => quoteIdentifier(column.name)).join(', ');
    return `INSERT INTO ${target.sql} (${targetNames})\nSELECT\n  ${expressions.join(',\n  ')}\nFROM EXTERNAL '${virtualFileName}'\n(\n${external}\n)\n${externalUsingClause()};`;
  }

  return `CREATE TABLE ${target.sql} AS (\n  SELECT\n    ${expressions.join(',\n    ')}\n  FROM EXTERNAL '${virtualFileName}'\n  (\n${external}\n  )\n  ${externalUsingClause()}\n) DISTRIBUTE ON RANDOM;`;
}

async function preparePreview(
  request: { filePath: string; sheetName?: string; hasHeader?: boolean; delimiter?: string },
  operation?: OperationContext
): Promise<NzImportPreview> {
  const format = fileFormat(request.filePath);
  const delimiter = format === 'csv' ? await csvDelimiter(request.filePath, request.delimiter) : undefined;
  const sheetNames = format === 'csv' ? [] : await excelSheetNames(request.filePath);
  const selectedSheet = format === 'csv' ? undefined : (request.sheetName || sheetNames[0]);
  const iterator = readSourceRows(request.filePath, format, delimiter, selectedSheet);
  const first = await iterator.next();
  if (first.done || !first.value) throw new Error('The selected file does not contain any data.');

  const hasHeader = request.hasHeader ?? autoHeader(first.value);
  const headerValues = hasHeader ? first.value : first.value.map((_value, index) => `COL_${index + 1}`);
  const names = uniqueIdentifiers(headerValues);
  const dataRows: string[][] = [];
  const valuesByColumn: string[][] = names.map(() => []);
  const maxLengths: number[] = names.map(() => 0);
  let rowCount = 0;

  const consume = (raw: string[]) => {
    operation?.checkCanceled();
    const width = Math.max(names.length, raw.length);
    while (valuesByColumn.length < width) valuesByColumn.push([]);
    while (maxLengths.length < width) maxLengths.push(0);
    while (names.length < width) names.push(`COL_${names.length + 1}`);
    const normalized = Array.from({ length: width }, (_value, index) => raw[index] || '');
    rowCount++;
    if (dataRows.length < MAX_SAMPLE_ROWS) dataRows.push(normalized);
    if (rowCount === 1 || rowCount % 1000 === 0) {
      operation?.progress({ phase: 'preview', message: `Scanned ${rowCount.toLocaleString()} rows`, rows: rowCount });
    }
    normalized.forEach((value, index) => {
      maxLengths[index] = Math.max(maxLengths[index], value.length);
      if (valuesByColumn[index].length < TYPE_SAMPLE_ROWS) valuesByColumn[index].push(value);
    });
  };

  if (!hasHeader) consume(first.value);
  for await (const raw of iterator) consume(raw);
  operation?.checkCanceled();

  const columns: NzImportColumn[] = names.map((name, index) => ({
    sourceIndex: index,
    sourceName: name,
    targetName: name,
    inferredType: inferType(valuesByColumn[index] || []),
    selected: true,
    sampleValues: (valuesByColumn[index] || []).slice(0, 5),
    maxLength: maxLengths[index] || 0
  }));
  return {
    filePath: request.filePath,
    fileName: basename(request.filePath),
    format,
    sheetNames,
    selectedSheet,
    hasHeader,
    delimiter,
    rowCount,
    sampleRows: dataRows,
    columns
  };
}

export async function previewImport(
  request: { filePath: string; sheetName?: string; hasHeader?: boolean; delimiter?: string },
  operation?: OperationContext
): Promise<NzImportPreview> {
  return preparePreview(request, operation);
}

async function* formattedImportRows(
  request: NzImportRequest,
  preview: NzImportPreview,
  columns: Array<{ sourceIndex: number; sourceName: string; outputName: string; type: string; externalType: string }>,
  operation: OperationContext
): AsyncGenerator<string> {
  const delimiter = preview.delimiter || ',';
  const rows = readSourceRows(request.filePath, request.format, delimiter, request.sheetName);
  let index = 0;
  let processed = 0;
  for await (const raw of rows) {
    operation.checkCanceled();
    if (index++ === 0 && request.hasHeader) continue;
    const values = columns.map((column) => externalValue(raw[column.sourceIndex] || '', column.type));
    processed++;
    if (processed === 1 || processed % 100 === 0) {
      operation.progress({ phase: 'stream', message: `Prepared ${processed.toLocaleString()} rows`, rows: processed, percent: preview.rowCount > 0 ? Math.min(100, Math.round(processed / preview.rowCount * 100)) : undefined });
    }
    yield `${values.join('\t')}\n`;
  }
}

export async function importToNetezza(
  connection: NzConnection,
  database: string,
  request: NzImportRequest,
  targetColumns: ImportTargetColumn[] | undefined,
  operation: OperationContext
): Promise<NzImportResult> {
  let stream: Readable | undefined;
  let registered = false;
  let commandStarted = false;
  const virtualFileName = `virtual_sql_editor_import_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`;
  operation.setCancelHandler(async () => {
    stream?.destroy();
    if (commandStarted) {
      try {
        await connection.cancel();
      } catch {
        // Cancellation is best effort; the command result determines the final state.
      }
    }
  });
  try {
    const preview = await preparePreview(request, operation);
    operation.checkCanceled();
    if (request.format !== preview.format) throw new Error('Import format changed. Please choose the file again.');
    const selected = request.columns.filter((column) => column.selected);
    if (selected.length === 0) throw new Error('Select at least one column to import.');
    const duplicateNames = new Set<string>();
    for (const column of selected) {
      const key = column.targetName.trim().toUpperCase();
      if (!key || duplicateNames.has(key)) throw new Error('Selected target column names must be unique and non-empty.');
      duplicateNames.add(key);
    }

    if (request.mode === 'append') {
      if (!targetColumns || targetColumns.length === 0) throw new Error('Could not read columns of the target table.');
      for (const column of selected) {
        if (!targetColumns.some((target) => target.name.toUpperCase() === column.targetName.toUpperCase())) {
          throw new Error(`Target column not found: ${column.targetName}`);
        }
      }
    }

    const sourceColumns = selected.map((column) => {
      const previewColumn = preview.columns.find((candidate) => candidate.sourceIndex === column.sourceIndex);
      if (!previewColumn) throw new Error(`Source column not found: ${column.sourceIndex + 1}`);
      const requestedType = normalizeType(column.dataType || previewColumn.inferredType);
      const effectiveType = requestedType === normalizeType(previewColumn.inferredType)
        ? textTypeForLength(requestedType, previewColumn.maxLength)
        : requestedType;
      return {
        sourceIndex: column.sourceIndex,
        sourceName: `SRC_${column.sourceIndex + 1}`,
        outputName: column.targetName,
        type: effectiveType,
        externalType: externalTypeForColumn(effectiveType, previewColumn.maxLength)
      };
    });
    validateRecordSize(sourceColumns.map((column) => ({ type: column.type, externalType: column.externalType })));
    const target = quoteTarget(request.targetTable);
    if (target.database && target.database.toUpperCase() !== database.toUpperCase()) {
      operation.progress({ phase: 'load', message: `Loading into ${request.targetTable}` });
    }
    await mkdir(join(tmpdir(), 'netezza-sql-editor-import-logs'), { recursive: true });

    stream = Readable.from(formattedImportRows(request, preview, sourceColumns, operation));
    NzConnection.registerImportStream(virtualFileName, stream);
    registered = true;
    const sql = buildImportSql(request, targetColumns, virtualFileName, sourceColumns);
    const command = connection.createCommand(sql);
    command.commandTimeout = request.timeoutSec && request.timeoutSec > 0 ? request.timeoutSec : 3600;
    const onDriverProgress = (value: unknown) => {
      const progress = value as { percentComplete?: number };
      operation.progress({ phase: 'load', message: typeof progress.percentComplete === 'number' ? `Netezza load: ${progress.percentComplete}%` : 'Netezza is loading the external stream', percent: progress.percentComplete });
    };
    connection.on('importProgress', onDriverProgress);
    try {
      operation.checkCanceled();
      operation.progress({ phase: 'load', message: 'Creating table and loading data…', percent: 0 });
      commandStarted = true;
      await command.execute();
    } finally {
      connection.off('importProgress', onDriverProgress);
    }
    operation.checkCanceled();
    operation.progress({ phase: 'load', message: 'Import completed', percent: 100, rows: preview.rowCount });
    return { ok: true, message: `Imported ${preview.rowCount.toLocaleString()} rows into ${request.targetTable}.`, rowsProcessed: preview.rowCount, rowsInserted: preview.rowCount, columns: sourceColumns.length, format: preview.format };
  } catch (error) {
    if (operation.canceled || error instanceof OperationCanceledError) {
      return { ok: false, canceled: true, message: 'Import canceled.', format: request.format };
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error), format: request.format };
  } finally {
    if (registered) NzConnection.unregisterImportStream(virtualFileName);
    if (stream && !stream.destroyed) stream.destroy();
  }
}

export function importDefaultTableName(filePath: string): string {
  return cleanIdentifier(basename(filePath, extname(filePath)), 'IMPORTED_DATA');
}
