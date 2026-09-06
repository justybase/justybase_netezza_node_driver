import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NzConnection } from '@justybase/netezza-driver';
import { XlsbWriter, XlsxWriter } from '@justybase/spreadsheet-tasks';
import type { NzImportPreview, NzImportRequest } from '../src/preload/api.ts';
import { buildImportSql, externalTypeForColumn, importToNetezza, previewImport } from '../src/main/importer.ts';
import { OperationContext } from '../src/main/operations.ts';

const headers = ['ID', 'NAME', 'AMOUNT', 'ACTIVE', 'EVENT_TIME'];
const dataRows = [
  [1, 'Zażółć gęślą jaźń', 12.5, true, new Date('2026-01-02T03:04:05Z')],
  [2, 'tekst; z separatorem', 99.75, false, new Date('2026-02-03T04:05:06Z')]
];

type WorkbookWriter = {
  startSheet: (name: string, columnCount: number, sheetHeaders?: string[]) => void;
  writeRow: (row: Array<string | number | boolean | Date | null>) => void;
  endSheet: () => void;
  finalize: () => Promise<void>;
};

async function createWorkbook(
  filePath: string,
  Writer: typeof XlsxWriter | typeof XlsbWriter
): Promise<void> {
  const writer = new Writer(filePath) as unknown as WorkbookWriter;
  writer.startSheet('ImportData', headers.length, headers);
  for (const row of dataRows) writer.writeRow(row);
  writer.endSheet();
  await writer.finalize();
}

async function createFixtures(directory: string): Promise<Record<'csv' | 'xlsx' | 'xlsb', string>> {
  const csv = join(directory, 'unicode-data.csv');
  await writeFile(
    csv,
    `\uFEFF${headers.join(';')}\r\n1;"Zażółć gęślą jaźń";12,5;true;2026-01-02 03:04:05\r\n2;"tekst; z separatorem";99,75;false;2026-02-03 04:05:06\r\n`,
    'utf8'
  );
  const xlsx = join(directory, 'unicode-data.xlsx');
  const xlsb = join(directory, 'unicode-data.xlsb');
  await createWorkbook(xlsx, XlsxWriter);
  await createWorkbook(xlsb, XlsbWriter);
  return { csv, xlsx, xlsb };
}

async function previewFixture(filePath: string): Promise<NzImportPreview> {
  return previewImport({ filePath, hasHeader: true });
}

function requestFromPreview(preview: NzImportPreview, targetTable: string, operationId: string): NzImportRequest {
  return {
    operationId,
    filePath: preview.filePath,
    format: preview.format,
    sheetName: preview.selectedSheet,
    hasHeader: preview.hasHeader,
    delimiter: preview.delimiter,
    targetTable,
    mode: 'create',
    rowCount: preview.rowCount,
    timeoutSec: 120,
    columns: preview.columns.map((column) => ({
      sourceIndex: column.sourceIndex,
      targetName: column.targetName,
      dataType: column.inferredType,
      selected: true
    }))
  };
}

test('generates and previews CSV, XLSX and XLSB fixtures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sql-editor-import-fixtures-'));
  try {
    const fixtures = await createFixtures(directory);
    for (const [format, filePath] of Object.entries(fixtures) as Array<['csv' | 'xlsx' | 'xlsb', string]>) {
      const preview = await previewFixture(filePath);
      assert.equal(preview.format, format);
      assert.equal(preview.hasHeader, true);
      assert.equal(preview.rowCount, 2);
      assert.deepEqual(preview.columns.map((column) => column.sourceName), headers);
      assert.equal(preview.columns[0].inferredType, 'BIGINT');
      assert.match(preview.columns[1].inferredType, /^NVARCHAR\(/);
      assert.equal(preview.columns[2].inferredType, 'NUMERIC(18,2)');
      assert.equal(preview.columns[3].inferredType, 'BOOLEAN');
      assert.equal(preview.columns[4].inferredType, 'TIMESTAMP');
      assert.equal(preview.sampleRows[0][1], 'Zażółć gęślą jaźń');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses UTF-8-compatible external column definitions for every inferred type', async () => {
  assert.equal(externalTypeForColumn('VARCHAR(255)', 20), 'NVARCHAR(20)');
  assert.equal(externalTypeForColumn('CHAR(10)', 5), 'NVARCHAR(5)');
  assert.equal(externalTypeForColumn('BIGINT', 0), 'BIGINT');
  assert.equal(externalTypeForColumn('NUMERIC(18,2)', 0), 'NUMERIC(18,2)');
  assert.equal(externalTypeForColumn('DATE', 0), 'DATE');
  assert.equal(externalTypeForColumn('BOOLEAN', 0), 'BOOLEAN');

  const request = {
    operationId: 'sql-generation-test',
    filePath: '/tmp/fixture.xlsx',
    format: 'xlsx' as const,
    hasHeader: true,
    targetTable: 'ADMIN.IMPORT_TEST',
    mode: 'create' as const,
    columns: headers.map((name, sourceIndex) => ({
      sourceIndex,
      targetName: name,
      dataType: ['BIGINT', 'NVARCHAR(20)', 'NUMERIC(18,2)', 'BOOLEAN', 'TIMESTAMP'][sourceIndex],
      selected: true
    }))
  } satisfies NzImportRequest;
  const sql = buildImportSql(request, undefined, 'virtual_import_test.txt', [
    { sourceIndex: 0, sourceName: 'SRC_1', outputName: 'ID', type: 'BIGINT', externalType: 'BIGINT' },
    { sourceIndex: 1, sourceName: 'SRC_2', outputName: 'NAME', type: 'NVARCHAR(20)', externalType: 'NVARCHAR(20)' },
    { sourceIndex: 2, sourceName: 'SRC_3', outputName: 'AMOUNT', type: 'NUMERIC(18,2)', externalType: 'NUMERIC(18,2)' },
    { sourceIndex: 3, sourceName: 'SRC_4', outputName: 'ACTIVE', type: 'BOOLEAN', externalType: 'BOOLEAN' },
    { sourceIndex: 4, sourceName: 'SRC_5', outputName: 'EVENT_TIME', type: 'TIMESTAMP', externalType: 'TIMESTAMP' }
  ]);
  const externalBlock = sql.slice(sql.indexOf('FROM EXTERNAL'), sql.indexOf(') DISTRIBUTE'));
  assert.doesNotMatch(externalBlock, /\b(?:CHAR|VARCHAR)\s*\(/i);
  assert.match(externalBlock, /"SRC_2" NVARCHAR\(20\)/);
  assert.match(externalBlock, /ENCODING 'Utf-8'/);

  let executedSql = '';
  const fakeConnection = {
    createCommand(sqlText: string) {
      executedSql = sqlText;
      return { commandTimeout: 0, execute: async () => undefined };
    },
    on: () => fakeConnection,
    off: () => fakeConnection
  } as unknown as NzConnection;
  const directory = await mkdtemp(join(tmpdir(), 'sql-editor-import-sql-'));
  try {
    const fixtures = await createFixtures(directory);
    const preview = await previewFixture(fixtures.xlsx);
    const result = await importToNetezza(
      fakeConnection,
      'JUST_DATA',
      requestFromPreview(preview, 'ADMIN.IMPORT_TEST', 'mock-import-test'),
      undefined,
      new OperationContext('mock-import-test', 'import')
    );
    assert.equal(result.ok, true);
    assert.match(executedSql, /FROM EXTERNAL/);
    const executedExternalBlock = executedSql.slice(executedSql.indexOf('FROM EXTERNAL'), executedSql.indexOf(') DISTRIBUTE'));
    assert.doesNotMatch(executedExternalBlock, /\b(?:CHAR|VARCHAR)\s*\(/i);
    assert.match(executedExternalBlock, /"SRC_2" NVARCHAR\(/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function liveConfig(): { host: string; port: number; database: string; user: string; password: string } | null {
  const { NZ_DEV_HOST: host, NZ_DEV_PASSWORD: password } = process.env;
  if (!host || !password) return null;
  return {
    host,
    password,
    port: Number(process.env.NZ_DEV_PORT || 5480),
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin'
  };
}

const live = liveConfig();
const runLiveImport = process.env.NZ_RUN_IMPORT_E2E === '1';

test('imports generated CSV/XLSX/XLSB files through the live Netezza virtual stream', { skip: !live || !runLiveImport, timeout: 180_000 }, async () => {
  const config = live!;
  const directory = await mkdtemp(join(tmpdir(), 'sql-editor-live-import-'));
  const schema = (process.env.NZ_DEV_SCHEMA || 'ADMIN').replace(/[^A-Za-z0-9_$#]/g, '');
  const suffix = `${process.pid}_${Date.now()}`;
  const tables: string[] = [];
  const connection = new NzConnection(config);
  try {
    await connection.connect();
    const fixtures = await createFixtures(directory);
    for (const [format, filePath] of Object.entries(fixtures) as Array<['csv' | 'xlsx' | 'xlsb', string]>) {
      const table = `SQL_EDITOR_IMPORT_E2E_${suffix}_${format.toUpperCase()}`;
      const qualified = `"${schema}"."${table}"`;
      tables.push(qualified);
      const preview = await previewFixture(filePath);
      const result = await importToNetezza(
        connection,
        config.database,
        requestFromPreview(preview, `${schema}.${table}`, `live-import-${format}`),
        undefined,
        new OperationContext(`live-import-${format}`, 'import')
      );
      assert.equal(result.ok, true, result.message);
      assert.equal(result.rowsInserted, 2);

      const check = await connection.query(`SELECT ID, NAME, AMOUNT, ACTIVE FROM ${qualified} ORDER BY ID`);
      assert.equal(check.rows.length, 2);
      assert.equal(String(check.rows[0].NAME), 'Zażółć gęślą jaźń');
      assert.equal(Number(check.rows[1].AMOUNT), 99.75);
    }
  } finally {
    for (const table of tables.reverse()) {
      await connection.createCommand(`DROP TABLE ${table}`).execute().catch(() => undefined);
    }
    await connection.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
