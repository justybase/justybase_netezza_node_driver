import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  connect: (params: unknown) => ipcRenderer.invoke('db:connect', params),
  disconnect: () => ipcRenderer.invoke('db:disconnect'),
  status: () => ipcRenderer.invoke('db:status'),
  query: (payload: unknown) => ipcRenderer.invoke('db:query', payload),
  cancel: (operationId?: string) => ipcRenderer.invoke('db:cancel', { operationId }),
  schema: () => ipcRenderer.invoke('db:schema'),
  columns: (payload: unknown) => ipcRenderer.invoke('db:columns', payload),
  exportCsv: (payload: unknown) => ipcRenderer.invoke('db:export-csv', payload),
  exportExcel: (payload: unknown) => ipcRenderer.invoke('db:export-excel', payload),
  openSqlFile: () => ipcRenderer.invoke('sql:open'),
  saveSqlFile: (payload: unknown) => ipcRenderer.invoke('sql:save', payload),
  pickImportFile: () => ipcRenderer.invoke('db:pick-import-file'),
  getDroppedFilePath: (file: unknown) => {
    const legacyPath = (file as { path?: unknown } | null)?.path;
    if (typeof legacyPath === 'string' && legacyPath.length > 0) return legacyPath;
    return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]);
  },
  previewImport: (payload: unknown) => ipcRenderer.invoke('db:preview-import', payload),
  importFile: (payload: unknown) => ipcRenderer.invoke('db:import-file', payload),
  onOperationProgress: (listener: (progress: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: unknown) => listener(progress);
    ipcRenderer.on('db:operation-progress', handler);
    return () => ipcRenderer.removeListener('db:operation-progress', handler);
  },
  completion: (payload: unknown) => ipcRenderer.invoke('db:completion', payload)
};

contextBridge.exposeInMainWorld('nz', api);
export type NzBridge = typeof api;
