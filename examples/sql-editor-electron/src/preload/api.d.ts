export interface NzField {
  name: string;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
}

export interface NzResultSet {
  index: number;
  rows: Record<string, unknown>[];
  fields: NzField[];
  rowCount: number;
  notices: string[];
  truncated: boolean;
  autoLimitApplied: boolean;
}

export interface NzStatementStatus {
  index: number;
  rowCount: number | null;
  notices: string[];
  message?: string;
}

export interface NzQueryOk {
  ok: true;
  resultSets: NzResultSet[];
  statements: NzStatementStatus[];
  /** Compatibility aliases for the first result set. */
  rows: Record<string, unknown>[];
  fields: NzField[];
  rowCount: number;
  notices: string[];
  elapsedMs: number;
  truncated: boolean;
  autoLimitApplied: boolean;
  sourceSql: string;
  executedSql: string;
}

export interface NzQueryErr {
  ok: false;
  canceled?: boolean;
  message: string;
  code?: string;
  detail?: string;
  elapsedMs: number;
  sourceSql: string;
  executedSql: string;
}

export type ImportFileFormat = 'csv' | 'xlsx' | 'xlsb';
export type ImportMode = 'create' | 'append';
export type NzOperationKind = 'query' | 'import-preview' | 'import' | 'export-csv' | 'export-excel';
export type NzOperationPhase = 'query' | 'preview' | 'stream' | 'load' | 'export';

export interface NzOperationProgress {
  operationId: string;
  kind: NzOperationKind;
  phase: NzOperationPhase;
  message: string;
  percent?: number;
  rows?: number;
}

export interface NzImportColumn {
  sourceIndex: number;
  sourceName: string;
  targetName: string;
  inferredType: string;
  selected: boolean;
  sampleValues: string[];
  maxLength: number;
  targetType?: string;
}

export interface NzImportPreview {
  filePath: string;
  fileName: string;
  format: ImportFileFormat;
  sheetNames: string[];
  selectedSheet?: string;
  hasHeader: boolean;
  delimiter?: string;
  rowCount: number;
  sampleRows: string[][];
  columns: NzImportColumn[];
}

export interface NzImportRequest {
  operationId: string;
  filePath: string;
  format: ImportFileFormat;
  sheetName?: string;
  hasHeader: boolean;
  delimiter?: string;
  targetTable: string;
  mode: ImportMode;
  columns: Array<{
    sourceIndex: number;
    targetName: string;
    dataType: string;
    selected: boolean;
  }>;
  rowCount?: number;
  timeoutSec?: number;
}

export interface NzImportResult {
  ok: boolean;
  canceled?: boolean;
  message: string;
  rowsProcessed?: number;
  rowsInserted?: number;
  columns?: number;
  format?: ImportFileFormat;
}

export type NzImportProgress = NzOperationProgress;

export interface NzImportPreviewCanceled {
  ok: false;
  canceled: true;
  message: string;
}

export type NzImportPreviewResult = NzImportPreview | NzImportPreviewCanceled;

export interface NzSqlFile {
  ok: true;
  filePath: string;
  fileName: string;
  sql: string;
}

export interface NzFileCanceled {
  ok: false;
  canceled: true;
}

export interface NzFileError {
  ok: false;
  canceled?: false;
  message: string;
}

export type NzOpenSqlResult = NzSqlFile | NzFileCanceled | NzFileError;
export type NzSaveSqlResult = { ok: true; filePath: string; fileName: string } | NzFileCanceled | NzFileError;

export type NzCompletionKind = 'keyword' | 'database' | 'schema' | 'table' | 'view' | 'column' | 'cte' | 'temp-table' | 'alias';

export interface NzCompletionItem {
  label: string;
  insertText?: string;
  detail?: string;
  kind: NzCompletionKind;
  sortText?: string;
}

export interface NzColumn {
  name: string;
  type: string;
}

export interface NzSchemaObject {
  name: string;
  kind: string;
  columns: NzColumn[];
}

export interface NzSchemaNode {
  name: string;
  objects: NzSchemaObject[];
}

export type NzObjectDefinitionKind = 'VIEW' | 'PROCEDURE';
export type NzObjectDefinitionResult =
  | { ok: true; content: string }
  | { ok: false; message: string };

export interface NzApi {
  connect: (params: {
    host: string;
    port?: number;
    database: string;
    user: string;
    password: string;
    uri?: string;
    commandTimeoutSec?: number;
  }) => Promise<{ ok: boolean; info: { host: string; database: string; user: string; port: number } }>;
  disconnect: () => Promise<{ ok: boolean }>;
  status: () => Promise<{ connected: boolean; info: { host: string; database: string; user: string; port: number } | null }>;
  query: (payload: { operationId: string; sql: string; maxRows?: number; timeoutSec?: number; applyAutoLimit?: boolean }) => Promise<NzQueryOk | NzQueryErr>;
  cancel: (operationId?: string) => Promise<{ ok: boolean; accepted: boolean }>;
  schema: () => Promise<{ schemas: NzSchemaNode[]; warning?: string }>;
  columns: (payload: { database?: string; schema?: string; table: string }) => Promise<NzColumn[]>;
  objectDefinition: (payload: { database?: string; schema: string; name: string; kind: NzObjectDefinitionKind }) => Promise<NzObjectDefinitionResult>;
  exportCsv: (payload: { operationId: string; rows: Record<string, unknown>[]; fields: NzField[]; defaultName?: string }) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; message?: string }>;
  exportExcel: (payload: { operationId: string; sql: string; resultSetIndex?: number; format: 'xlsx' | 'xlsb'; timeoutSec?: number; defaultName?: string }) => Promise<
    | { ok: true; filePath: string; rowsExported: number; columns: number }
    | { ok: false; canceled?: boolean; message?: string }
  >;
  openSqlFile: () => Promise<NzOpenSqlResult>;
  saveSqlFile: (payload: { sql: string; filePath?: string; defaultName?: string; saveAs?: boolean }) => Promise<NzSaveSqlResult>;
  pickImportFile: () => Promise<{ canceled: boolean; filePath?: string }>;
  getDroppedFilePath: (file: unknown) => string;
  previewImport: (payload: { operationId: string; filePath: string; sheetName?: string; hasHeader?: boolean; delimiter?: string }) => Promise<NzImportPreviewResult>;
  importFile: (payload: NzImportRequest) => Promise<NzImportResult>;
  onOperationProgress: (listener: (progress: NzOperationProgress) => void) => () => void;
  completion: (payload: { sql: string; offset: number }) => Promise<{ items: NzCompletionItem[] }>;
}

declare global {
  interface Window {
    nz: NzApi;
  }
}

export {};
