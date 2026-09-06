import { ipcMain, dialog, BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { connect, disconnect, status, runQuery, cancel, getSchemaTree, getColumns, getObjectDefinition, exportRowsToCsv, getCompletionItems, exportQueryToExcel, previewImportFile, importFile } from './db';

let registered = false;

function addExtension(filePath: string, extension: 'xlsx' | 'xlsb'): string {
  return /\.(xlsx|xlsb)$/i.test(filePath) ? filePath.replace(/\.(xlsx|xlsb)$/i, `.${extension}`) : `${filePath}.${extension}`;
}

function addSqlExtension(filePath: string): string {
  return /\.sql$/i.test(filePath) ? filePath : `${filePath}.sql`;
}

function addCsvExtension(filePath: string): string {
  return /\.csv$/i.test(filePath) ? filePath : `${filePath}.csv`;
}

function sendProgress(event: Electron.IpcMainInvokeEvent) {
  return (progress: unknown) => event.sender.send('db:operation-progress', progress);
}

export function registerIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('db:connect', async (_e, params) => {
    const info = await connect(params);
    return { ok: true, info };
  });

  ipcMain.handle('db:disconnect', async () => {
    await disconnect();
    return { ok: true };
  });

  ipcMain.handle('db:status', async () => status());

  ipcMain.handle('db:query', async (event, payload: { operationId: string; sql: string; maxRows?: number; timeoutSec?: number; applyAutoLimit?: boolean }) => {
    return runQuery(payload.sql, {
      operationId: payload.operationId,
      onProgress: sendProgress(event),
      maxRows: payload.maxRows,
      timeoutSec: payload.timeoutSec,
      applyAutoLimit: payload.applyAutoLimit
    });
  });

  ipcMain.handle('db:cancel', async (_e, payload: { operationId?: string }) => {
    const result = await cancel(payload?.operationId);
    return { ok: true, accepted: result.accepted };
  });

  ipcMain.handle('db:schema', async () => getSchemaTree());

  ipcMain.handle('db:columns', async (_e, payload: { database?: string; schema?: string; table: string }) => {
    return getColumns(payload.schema, payload.table, payload.database);
  });

  ipcMain.handle('db:object-definition', async (_e, payload: { database?: string; schema: string; name: string; kind: 'VIEW' | 'PROCEDURE' }) => {
    if (!payload?.schema || !payload?.name || !['VIEW', 'PROCEDURE'].includes(payload.kind)) {
      return { ok: false, message: 'Schema, object name and a supported object type are required.' };
    }
    return getObjectDefinition(payload.schema, payload.name, payload.kind, payload.database);
  });

  ipcMain.handle('db:completion', async (_e, payload: { sql: string; offset: number }) => {
    if (!payload || typeof payload.sql !== 'string') return { items: [] };
    const offset = Number.isFinite(payload.offset) ? Math.max(0, Math.floor(payload.offset)) : payload.sql.length;
    return getCompletionItems(payload.sql, offset);
  });

  ipcMain.handle('db:export-csv', async (event, payload: { operationId: string; rows: Record<string, unknown>[]; fields: { name: string }[]; defaultName?: string }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export results to CSV',
      defaultPath: payload.defaultName || 'results.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const outputPath = addCsvExtension(filePath);
      const exported = await exportRowsToCsv(payload.rows || [], payload.fields || [], outputPath, payload.operationId, sendProgress(event));
      if ('canceled' in exported) return { ok: false, canceled: true };
      return { ok: true, filePath: outputPath, rowsExported: exported.rowsExported };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('db:export-excel', async (event, payload: { operationId: string; sql: string; resultSetIndex?: number; format: 'xlsx' | 'xlsb'; timeoutSec?: number; defaultName?: string }) => {
    if (!payload || typeof payload.sql !== 'string' || !['xlsx', 'xlsb'].includes(payload.format)) {
      return { ok: false, message: 'Invalid Excel export request.' };
    }
    const format = payload.format;
    const defaultName = payload.defaultName?.trim() || 'results';
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: `Export results to ${format.toUpperCase()}`,
      defaultPath: addExtension(defaultName, format),
      filters: [{ name: format === 'xlsx' ? 'Excel Workbook' : 'Excel Binary Workbook', extensions: [format] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const outputPath = addExtension(filePath, format);
      const exported = await exportQueryToExcel(payload.sql, outputPath, format, payload.timeoutSec, payload.resultSetIndex ?? 0, payload.operationId, sendProgress(event));
      if ('canceled' in exported) return { ok: false, canceled: true };
      return { ok: true, filePath: outputPath, ...exported };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('sql:open', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const response = await dialog.showOpenDialog(win, {
      title: 'Open SQL file',
      properties: ['openFile'],
      filters: [{ name: 'SQL files', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (response.canceled || response.filePaths.length === 0) return { ok: false, canceled: true };
    const filePath = response.filePaths[0];
    try {
      const sql = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
      return { ok: true, filePath, fileName: basename(filePath), sql };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('sql:save', async (_e, payload: { sql: string; filePath?: string; defaultName?: string; saveAs?: boolean }) => {
    if (!payload || typeof payload.sql !== 'string') return { ok: false, message: 'SQL text is required.' };
    let filePath = payload.filePath?.trim();
    if (payload.saveAs || !filePath) {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const response = await dialog.showSaveDialog(win, {
        title: payload.saveAs ? 'Save SQL file as' : 'Save SQL file',
        defaultPath: addSqlExtension(payload.defaultName?.trim() || 'query.sql'),
        filters: [{ name: 'SQL files', extensions: ['sql'] }]
      });
      if (response.canceled || !response.filePath) return { ok: false, canceled: true };
      filePath = response.filePath;
    }
    const outputPath = addSqlExtension(filePath);
    try {
      await writeFile(outputPath, payload.sql, 'utf8');
      return { ok: true, filePath: outputPath, fileName: basename(outputPath) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('db:pick-import-file', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const response = await dialog.showOpenDialog(win, {
      title: 'Import data into Netezza',
      properties: ['openFile'],
      filters: [{ name: 'Tabular files', extensions: ['csv', 'xlsx', 'xlsb'] }]
    });
    return response.canceled || response.filePaths.length === 0
      ? { canceled: true }
      : { canceled: false, filePath: response.filePaths[0] };
  });

  ipcMain.handle('db:preview-import', async (event, payload: { operationId: string; filePath: string; sheetName?: string; hasHeader?: boolean; delimiter?: string }) => {
    if (!payload?.filePath) throw new Error('Import file path is required.');
    return previewImportFile(payload, sendProgress(event));
  });

  ipcMain.handle('db:import-file', async (event, payload) => {
    if (!payload?.filePath || !payload?.targetTable) {
      return { ok: false, message: 'Import file and target table are required.' };
    }
    return importFile(payload, (progress) => {
      event.sender.send('db:operation-progress', progress);
    });
  });
}
