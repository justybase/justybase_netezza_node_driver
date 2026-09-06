import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from './components/TopBar';
import ConnectionDialog from './components/ConnectionDialog';
import ImportWizard from './components/ImportWizard';
import SchemaBrowser from './components/SchemaBrowser';
import SqlEditor from './components/SqlEditor';
import ResultsTable from './components/ResultsTable';
import StatusBar from './components/StatusBar';
import { loadHistory, pushHistory, clearHistory, type HistoryEntry } from './lib/history';
import { SAMPLE_SQL, formatMs } from './lib/format';
import type { NzColumn, NzImportResult, NzOperationKind, NzOperationProgress, NzQueryErr, NzQueryOk, NzResultSet, NzSchemaNode } from '../../preload/api';

type PaneTab = 'results' | 'messages' | 'history';
type ExportFormat = 'xlsx' | 'xlsb';
type Toast = { tone: 'success' | 'error' | 'info'; message: string };

interface SqlSettings {
  maxRows: number;
  timeoutSec: number;
  autoLimit: boolean;
}

interface SqlExecution {
  id: string;
  runNumber: number;
  at: string;
  response: NzQueryOk | NzQueryErr;
}

interface SqlTabState {
  id: string;
  title: string;
  filePath?: string;
  sql: string;
  initialSql: string;
  dirty: boolean;
  pane: PaneTab;
  executions: SqlExecution[];
  activeResultId: string | null;
  settings: SqlSettings;
}

interface ResultRef {
  id: string;
  execution: SqlExecution;
  resultSet: NzResultSet;
}

interface ActiveOperation {
  id: string;
  kind: NzOperationKind;
  label: string;
}

const DEFAULT_CONN = { host: '192.168.0.144', port: 5480, database: 'JUST_DATA', user: 'admin' };
const DEFAULT_SETTINGS: SqlSettings = { maxRows: 1000, timeoutSec: 30, autoLimit: true };

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSqlTab(title: string, sql = '', filePath?: string): SqlTabState {
  return { id: id('sql'), title, filePath, sql, initialSql: sql, dirty: false, pane: 'results', executions: [], activeResultId: null, settings: { ...DEFAULT_SETTINGS } };
}

function normalizedFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLocaleLowerCase();
}

function resultRefs(tab: SqlTabState): ResultRef[] {
  return tab.executions.flatMap((execution) => execution.response.ok
    ? execution.response.resultSets.map((resultSet) => ({ id: `${execution.id}:${resultSet.index}`, execution, resultSet }))
    : []);
}

function latestExecution(tab: SqlTabState): SqlExecution | null {
  return tab.executions.length > 0 ? tab.executions[tab.executions.length - 1] : null;
}

function executionRowCount(response: NzQueryOk | NzQueryErr): number | undefined {
  if (!response.ok) return undefined;
  return response.resultSets.reduce((total, resultSet) => total + resultSet.rows.length, 0);
}

function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!window.nz;
}

export default function App() {
  const nextTabNumber = useRef(2);
  const [connected, setConnected] = useState(false);
  const [connInfo, setConnInfo] = useState<{ host: string; database: string; user: string; port: number } | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [sqlTabs, setSqlTabs] = useState<SqlTabState[]>(() => [createSqlTab('Query 1', SAMPLE_SQL)]);
  const [activeSqlTabId, setActiveSqlTabId] = useState('');
  const [runningTabId, setRunningTabId] = useState<string | null>(null);
  const [activeOperation, setActiveOperation] = useState<ActiveOperation | null>(null);
  const [operationProgress, setOperationProgress] = useState<NzOperationProgress | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [schemas, setSchemas] = useState<NzSchemaNode[]>([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaWarning, setSchemaWarning] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());

  useEffect(() => {
    setActiveSqlTabId((current) => current || sqlTabs[0]?.id || '');
  }, [sqlTabs]);

  const activeSqlTab = sqlTabs.find((tab) => tab.id === activeSqlTabId) ?? sqlTabs[0];
  const activeResults = useMemo(() => activeSqlTab ? resultRefs(activeSqlTab) : [], [activeSqlTab]);
  const activeResult = activeResults.find((result) => result.id === activeSqlTab?.activeResultId) ?? activeResults[activeResults.length - 1] ?? null;
  const latest = activeSqlTab ? latestExecution(activeSqlTab) : null;
  const latestResponse = latest?.response ?? null;
  const statusResult = activeResult?.resultSet ?? null;
  const statusOk = statusResult || (latestResponse?.ok ? latestResponse : null);
  const statusErr = !statusResult && latestResponse && !latestResponse.ok ? latestResponse : null;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!hasBridge()) return;
    return window.nz.onOperationProgress((progress) => setOperationProgress(progress));
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        void doOpenSql();
      } else if (key === 's') {
        event.preventDefault();
        if (event.shiftKey) void doSaveSqlAs();
        else void doSaveSql();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!sqlTabs.some((tab) => tab.dirty)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [sqlTabs]);

  const refreshSchema = useCallback(async () => {
    if (!hasBridge()) return;
    setSchemaLoading(true);
    try {
      const tree = await window.nz.schema();
      setSchemas(tree.schemas);
      setSchemaWarning(tree.warning);
    } catch {
      setSchemas([]);
      setSchemaWarning('Failed to load schema.');
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasBridge()) return;
    window.nz.status().then((status) => {
      setConnected(status.connected);
      setConnInfo(status.info);
      if (status.connected) void refreshSchema();
    }).catch(() => undefined);
  }, [refreshSchema]);

  const updateTab = (tabId: string, update: (tab: SqlTabState) => SqlTabState) => {
    setSqlTabs((current) => current.map((tab) => tab.id === tabId ? update(tab) : tab));
  };

  const updateActiveTab = (update: (tab: SqlTabState) => SqlTabState) => {
    if (activeSqlTab) updateTab(activeSqlTab.id, update);
  };

  const doConnect = async (params: { host: string; port: number; database: string; user: string; password: string; uri?: string }) => {
    if (!hasBridge()) {
      setConnectError('Electron bridge (window.nz) is missing. Run via `npm run dev`, not plain Vite.');
      return;
    }
    setConnectBusy(true);
    setConnectError(null);
    try {
      const response = await window.nz.connect({ ...params, commandTimeoutSec: activeSqlTab?.settings.timeoutSec ?? 30 });
      setConnected(true);
      setConnInfo(response.info);
      setShowConnect(false);
      void refreshSchema();
    } catch (cause) {
      setConnectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnectBusy(false);
    }
  };

  const doDisconnect = async () => {
    if (activeOperation) return;
    await window.nz.disconnect().catch(() => undefined);
    setConnected(false);
    setConnInfo(null);
    setSchemas([]);
  };

  const doOpenSql = async () => {
    if (!hasBridge()) {
      setToast({ tone: 'error', message: 'Electron bridge (window.nz) is missing.' });
      return;
    }
    try {
      const response = await window.nz.openSqlFile();
      if (!response.ok) {
        if (!response.canceled) setToast({ tone: 'error', message: response.message });
        return;
      }
      const existing = sqlTabs.find((tab) => tab.filePath && normalizedFilePath(tab.filePath) === normalizedFilePath(response.filePath));
      if (existing) {
        setActiveSqlTabId(existing.id);
        return;
      }
      const tab = createSqlTab(response.fileName, response.sql, response.filePath);
      setSqlTabs((current) => [...current, tab]);
      setActiveSqlTabId(tab.id);
    } catch (cause) {
      setToast({ tone: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const saveSqlTab = async (tab: SqlTabState, saveAs: boolean) => {
    if (!hasBridge()) {
      setToast({ tone: 'error', message: 'Electron bridge (window.nz) is missing.' });
      return;
    }
    const sqlAtRequest = tab.sql;
    try {
      const response = await window.nz.saveSqlFile({ sql: sqlAtRequest, filePath: tab.filePath, defaultName: tab.title, saveAs });
      if (!response.ok) {
        if (!response.canceled) setToast({ tone: 'error', message: response.message });
        return;
      }
      updateTab(tab.id, (current) => ({
        ...current,
        title: response.fileName,
        filePath: response.filePath,
        initialSql: sqlAtRequest,
        dirty: current.sql !== sqlAtRequest
      }));
      setToast({ tone: 'success', message: `SQL saved: ${response.filePath}` });
    } catch (cause) {
      setToast({ tone: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const doSaveSql = async () => {
    if (activeSqlTab) await saveSqlTab(activeSqlTab, false);
  };

  const doSaveSqlAs = async () => {
    if (activeSqlTab) await saveSqlTab(activeSqlTab, true);
  };

  const doRun = async (selection?: string) => {
    const tab = activeSqlTab;
    if (!tab || activeOperation) return;
    const text = (selection ?? tab.sql).trim();
    if (!text) return;
    if (!hasBridge()) {
      const response: NzQueryErr = { ok: false, message: 'Electron bridge (window.nz) is missing.', elapsedMs: 0, sourceSql: text, executedSql: text };
      updateTab(tab.id, (current) => ({ ...current, executions: [...current.executions, { id: id('run'), runNumber: current.executions.length + 1, at: new Date().toISOString(), response }], pane: 'messages' }));
      return;
    }
    if (!connected) {
      setShowConnect(true);
      return;
    }

    const operationId = id('op');
    setRunningTabId(tab.id);
    setActiveOperation({ id: operationId, kind: 'query', label: 'query' });
    try {
      const response = await window.nz.query({ operationId, sql: text, ...tab.settings });
      const execution: SqlExecution = { id: id('run'), runNumber: tab.executions.length + 1, at: new Date().toISOString(), response };
      const newResultId = response.ok && response.resultSets.length > 0 ? `${execution.id}:${response.resultSets[0].index}` : null;
      updateTab(tab.id, (current) => ({
        ...current,
        executions: [...current.executions, execution],
        activeResultId: newResultId || current.activeResultId,
        pane: response.ok && response.resultSets.length > 0 ? 'results' : 'messages'
      }));
      const entry: HistoryEntry = {
        id: execution.id,
        sql: text.slice(0, 2000),
        at: execution.at,
        ok: response.ok,
        elapsedMs: response.elapsedMs,
        rowCount: executionRowCount(response),
        message: response.ok ? undefined : response.message
      };
      setHistory(pushHistory(entry));
    } catch (cause) {
      const response: NzQueryErr = { ok: false, message: cause instanceof Error ? cause.message : String(cause), elapsedMs: 0, sourceSql: text, executedSql: text };
      updateTab(tab.id, (current) => ({ ...current, executions: [...current.executions, { id: id('run'), runNumber: current.executions.length + 1, at: new Date().toISOString(), response }], pane: 'messages' }));
    } finally {
      setRunningTabId(null);
      setActiveOperation((current) => current?.id === operationId ? null : current);
      setOperationProgress((current) => current?.operationId === operationId ? null : current);
    }
  };

  const doCancel = async () => {
    const operation = activeOperation;
    if (!operation) return;
    setOperationProgress((current) => current ? { ...current, message: 'Canceling operation…' } : null);
    await window.nz.cancel(operation.id).catch(() => undefined);
  };

  const doExportCsv = async () => {
    if (!activeResult || activeResult.resultSet.fields.length === 0 || activeOperation) return;
    const operationId = id('op');
    setActiveOperation({ id: operationId, kind: 'export-csv', label: 'CSV export' });
    try {
      const response = await window.nz.exportCsv({ operationId, rows: activeResult.resultSet.rows, fields: activeResult.resultSet.fields, defaultName: 'results.csv' });
      if (response.ok) setToast({ tone: 'success', message: `CSV saved: ${response.filePath}` });
      else if (!response.canceled) setToast({ tone: 'error', message: response.message || 'Could not export CSV.' });
    } catch (cause) {
      setToast({ tone: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setActiveOperation((current) => current?.id === operationId ? null : current);
      setOperationProgress((current) => current?.operationId === operationId ? null : current);
    }
  };

  const doExportExcel = async (format: ExportFormat) => {
    if (!activeResult || exporting || activeOperation || !activeResult.execution.response.ok) return;
    const operationId = id('op');
    setActiveOperation({ id: operationId, kind: 'export-excel', label: `${format.toUpperCase()} export` });
    setExporting(format);
    try {
      const response = await window.nz.exportExcel({ operationId, sql: activeResult.execution.response.sourceSql, resultSetIndex: activeResult.resultSet.index, format, timeoutSec: activeSqlTab?.settings.timeoutSec, defaultName: 'results' });
      if (response.ok) setToast({ tone: 'success', message: `${format.toUpperCase()} saved: ${response.filePath} · ${response.rowsExported.toLocaleString()} rows` });
      else if (!response.canceled) setToast({ tone: 'error', message: response.message || `Could not export ${format.toUpperCase()}.` });
    } catch (cause) {
      setToast({ tone: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setExporting(null);
      setActiveOperation((current) => current?.id === operationId ? null : current);
      setOperationProgress((current) => current?.operationId === operationId ? null : current);
    }
  };

  const newSqlTab = () => {
    const tab = createSqlTab(`Query ${nextTabNumber.current++}`);
    setSqlTabs((current) => [...current, tab]);
    setActiveSqlTabId(tab.id);
  };

  const closeSqlTab = (tab: SqlTabState) => {
    if (activeOperation) return;
    if (tab.dirty && !window.confirm(`Close ${tab.title} and discard its SQL changes?`)) return;
    if (sqlTabs.length === 1) {
      const replacement = createSqlTab(tab.title, '');
      setSqlTabs([replacement]);
      setActiveSqlTabId(replacement.id);
      return;
    }
    const index = sqlTabs.findIndex((candidate) => candidate.id === tab.id);
    const remaining = sqlTabs.filter((candidate) => candidate.id !== tab.id);
    setSqlTabs(remaining);
    if (tab.id === activeSqlTabId) setActiveSqlTabId(remaining[Math.max(0, index - 1)]?.id || remaining[0].id);
  };

  const pickTable = (schema: string, table: string) => {
    updateActiveTab((current) => ({ ...current, sql: `SELECT *\nFROM "${schema}"."${table}"\nLIMIT 100;\n`, dirty: true, pane: 'results' }));
  };

  const loadTableColumns = useCallback(async (schema: string, table: string): Promise<NzColumn[]> => {
    try {
      const columns = await window.nz.columns({ database: connInfo?.database, schema, table });
      setSchemas((current) => current.map((entry) => entry.name !== schema ? entry : { ...entry, tables: entry.tables.map((item) => item.name !== table ? item : { ...item, columns }) }));
      return columns;
    } catch (cause) {
      setToast({ tone: 'error', message: cause instanceof Error ? cause.message : String(cause) });
      return [];
    }
  }, [connInfo?.database]);

  const showColumns = async (schema: string, table: string) => {
    const columns = await loadTableColumns(schema, table);
    if (columns.length === 0) {
      pickTable(schema, table);
      return;
    }
    const list = columns.map((column) => `  "${column.name}"`).join(',\n');
    updateActiveTab((current) => ({ ...current, sql: `-- ${schema}.${table} (${columns.map((column) => `${column.name} ${column.type}`).join(', ')})\nSELECT\n${list}\nFROM "${schema}"."${table}"\nLIMIT 100;\n`, dirty: true }));
  };

  const handleHistory = (entry: HistoryEntry) => {
    updateActiveTab((current) => ({ ...current, sql: entry.sql, dirty: true, pane: 'results' }));
  };

  const onImported = (result: NzImportResult) => {
    setToast({ tone: 'success', message: result.message });
    void refreshSchema();
  };

  const onImportOperationChange = (operation: ActiveOperation | null) => {
    setActiveOperation(operation);
    if (!operation) setOperationProgress(null);
  };

  const operationLabel = activeOperation
    ? operationProgress?.operationId === activeOperation.id && operationProgress.message
      ? `${activeOperation.label}: ${operationProgress.message}`
      : activeOperation.label
    : undefined;

  return (
    <div className="flex h-full flex-col bg-slate-950">
      <TopBar connected={connected} info={connInfo} running={!!activeOperation} operationLabel={operationLabel} onCancelOperation={() => void doCancel()} onConnect={() => setShowConnect(true)} onDisconnect={doDisconnect} onOpenSql={() => void doOpenSql()} onSaveSql={() => void doSaveSql()} onSaveSqlAs={() => void doSaveSqlAs()} onImport={() => { if (!activeOperation) setShowImport(true); }} />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[300px] shrink-0 border-r border-slate-800 bg-slate-900/40 md:block">
          <SchemaBrowser schemas={schemas} loading={schemaLoading} connected={connected} warning={schemaWarning} onRefresh={refreshSchema} onPickTable={pickTable} onShowColumns={showColumns} onLoadColumns={loadTableColumns} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900/80 px-2 pt-1.5">
            {sqlTabs.map((tab) => (
              <div key={tab.id} className={`flex shrink-0 items-center rounded-t-lg border border-b-0 ${tab.id === activeSqlTab?.id ? 'border-slate-700 bg-slate-950' : 'border-transparent text-slate-500 hover:bg-slate-800/60'}`}>
                <button onClick={() => setActiveSqlTabId(tab.id)} className="px-3 py-2 text-xs font-medium">{tab.dirty && <span className="mr-1 text-amber-300">●</span>}{tab.title}{runningTabId === tab.id && <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />}</button>
                <button onClick={() => closeSqlTab(tab)} disabled={!!activeOperation} className="px-2 py-2 text-slate-600 hover:text-slate-200 disabled:opacity-30" aria-label={`Close ${tab.title}`}>×</button>
              </div>
            ))}
            <button onClick={newSqlTab} className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-800 hover:text-white" aria-label="New SQL tab">＋</button>
          </div>

          {activeSqlTab && <div className="min-h-[220px] basis-[42%] border-b border-slate-800"><SqlEditor value={activeSqlTab.sql} running={!!runningTabId} connected={connected} maxRows={activeSqlTab.settings.maxRows} timeoutSec={activeSqlTab.settings.timeoutSec} autoLimit={activeSqlTab.settings.autoLimit} onChange={(value) => updateTab(activeSqlTab.id, (current) => ({ ...current, sql: value, dirty: value !== current.initialSql }))} onRun={doRun} onCancel={doCancel} setMaxRows={(value) => updateActiveTab((current) => ({ ...current, settings: { ...current.settings, maxRows: value } }))} setTimeoutSec={(value) => updateActiveTab((current) => ({ ...current, settings: { ...current.settings, timeoutSec: value } }))} setAutoLimit={(value) => updateActiveTab((current) => ({ ...current, settings: { ...current.settings, autoLimit: value } }))} /></div>}

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-slate-800 bg-slate-900/60 px-2 pt-1.5">
              {(['results', 'messages', 'history'] as PaneTab[]).map((pane) => (
                <button key={pane} onClick={() => updateActiveTab((current) => ({ ...current, pane }))} className={`rounded-t-lg px-3 py-1.5 text-xs font-medium transition ${activeSqlTab?.pane === pane ? 'bg-slate-950 text-white shadow-[inset_0_1px_0_#6366f1]' : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300'}`}>
                  {pane === 'results' ? `Results${activeResults.length ? ` (${activeResults.length})` : ''}` : pane === 'messages' ? `Messages${latestResponse && !latestResponse.ok ? ' (1)' : ''}` : `History (${history.length})`}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-2 pb-1.5">
                {activeResult && (
                  <>
                    <button onClick={() => void doExportCsv()} disabled={!!activeOperation || !!exporting} className="rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">⬇ CSV</button>
                    <button onClick={() => void doExportExcel('xlsx')} disabled={!!activeOperation || !!exporting} className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200 transition hover:border-emerald-400/60 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40">{exporting === 'xlsx' ? '… XLSX' : '⬇ XLSX'}</button>
                    <button onClick={() => void doExportExcel('xlsb')} disabled={!!activeOperation || !!exporting} className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-200 transition hover:border-cyan-400/60 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40">{exporting === 'xlsb' ? '… XLSB' : '⬇ XLSB'}</button>
                  </>
                )}
                {activeSqlTab?.pane === 'history' && history.length > 0 && <button onClick={() => setHistory(clearHistory())} className="rounded-lg px-2 py-1 text-[11px] text-slate-500 transition hover:bg-slate-800 hover:text-slate-300">Clear</button>}
              </div>
            </div>

            <div className="min-h-0 flex-1 bg-slate-950">
              {activeSqlTab?.pane === 'results' && (
                activeResults.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center p-8 text-center"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10 text-2xl">⌁</div><div className="mt-3 text-sm font-medium text-slate-300">{latestResponse && !latestResponse.ok ? 'No result — query failed' : 'Run your first query'}</div><div className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">{connected ? 'Ctrl/⌘ + Enter runs the selection or everything. Each result set appears as a separate result tab.' : 'Connect to the database first with the Connect button in the top bar.'}</div></div>
                ) : (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900/40 px-3 py-1.5">{activeResults.map((result, index) => <button key={result.id} onClick={() => updateActiveTab((current) => ({ ...current, activeResultId: result.id }))} className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] ${activeResult?.id === result.id ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'}`}>Run {result.execution.runNumber} · Result {index + 1} <span className="ml-1 text-slate-600">{result.resultSet.rows.length.toLocaleString()}</span></button>)}</div>
                    <div className="min-h-0 flex-1"><ResultsTable key={activeResult?.id} rows={activeResult?.resultSet.rows ?? []} fields={activeResult?.resultSet.fields ?? []} /></div>
                  </div>
                )
              )}

              {activeSqlTab?.pane === 'messages' && <div className="h-full overflow-y-auto p-3">{activeSqlTab.executions.length === 0 ? <div className="p-4 text-center text-xs text-slate-600">No messages — run a query.</div> : <div className="space-y-2">{[...activeSqlTab.executions].reverse().map((execution) => { const canceled = !execution.response.ok && execution.response.canceled; return <div key={execution.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3"><div className="flex items-center gap-2 text-[11px]"><span className={`rounded px-1.5 py-0.5 font-semibold ${execution.response.ok ? 'bg-emerald-500/15 text-emerald-300' : canceled ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/15 text-red-300'}`}>{execution.response.ok ? 'OK' : canceled ? 'CANCELED' : 'ERR'}</span><span className="text-slate-500">Run {execution.runNumber} · {new Date(execution.at).toLocaleString()}</span><span className="ml-auto font-mono text-slate-500">{formatMs(execution.response.elapsedMs)}</span></div><div className="mt-2 truncate font-mono text-[11px] text-slate-400">{execution.response.executedSql}</div>{execution.response.ok ? <div className="mt-2 space-y-1">{execution.response.statements.map((statement) => <div key={statement.index} className="text-[11px] text-slate-500">Statement {statement.index + 1} completed{statement.rowCount !== null ? ` · ${statement.rowCount} rows affected` : ''}{statement.notices.length > 0 ? ` · ${statement.notices.length} notices` : ''}</div>)}{execution.response.notices.map((notice, index) => <div key={index} className="rounded border border-sky-500/20 bg-sky-500/[0.07] px-2 py-1.5 text-xs text-sky-200">{notice}</div>)}{execution.response.resultSets.some((result) => result.autoLimitApplied) && <div className="text-[11px] text-amber-300">Preview auto-LIMIT is enabled; Excel export reruns the source query without the preview limit.</div>}</div> : <div className={`mt-2 font-mono text-xs ${canceled ? 'text-amber-200' : 'text-red-200'}`}>{execution.response.message}{execution.response.detail && <div className={canceled ? 'mt-1 text-amber-300/60' : 'mt-1 text-red-300/60'}>{execution.response.detail}</div>}</div>}</div>; })}</div>}</div>}

              {activeSqlTab?.pane === 'history' && <div className="h-full overflow-y-auto p-2">{history.length === 0 ? <div className="p-6 text-center text-xs text-slate-600">History is empty — every execution lands here.</div> : history.map((entry) => <button key={entry.id} onClick={() => handleHistory(entry)} className="mb-1.5 block w-full rounded-xl border border-slate-800/80 bg-slate-900/50 p-2.5 text-left transition hover:border-indigo-500/40 hover:bg-slate-900"><div className="flex items-center gap-2 text-[11px]"><span className={`rounded px-1.5 py-0.5 font-semibold ${entry.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{entry.ok ? 'OK' : 'ERR'}</span><span className="font-mono text-slate-500">{new Date(entry.at).toLocaleString()}</span><span className="ml-auto font-mono text-slate-500">{formatMs(entry.elapsedMs)}{entry.rowCount !== undefined && ` · ${entry.rowCount} rows`}</span></div><div className="mt-1.5 truncate font-mono text-[11px] text-slate-300">{entry.sql.split('\n')[0]}</div>{!entry.ok && entry.message && <div className="mt-0.5 truncate text-[11px] text-red-300/70">{entry.message}</div>}</button>)}</div>}
            </div>
          </div>
        </main>
      </div>

      <StatusBar elapsedMs={latestResponse?.elapsedMs ?? null} rowCount={statusResult?.rows.length ?? (statusOk && 'rows' in statusOk ? statusOk.rows.length : null)} truncated={!!statusResult?.truncated || !!(statusOk && 'truncated' in statusOk && statusOk.truncated)} autoLimitApplied={!!statusResult?.autoLimitApplied || !!(statusOk && 'autoLimitApplied' in statusOk && statusOk.autoLimitApplied)} noticesCount={statusResult?.notices.length ?? (latestResponse?.ok ? latestResponse.notices.length : 0)} errorCode={statusErr?.code} />

      <ConnectionDialog open={showConnect} initial={DEFAULT_CONN} busy={connectBusy} error={connectError} onClose={() => setShowConnect(false)} onSubmit={doConnect} />
      <ImportWizard open={showImport} connected={connected} database={connInfo?.database} timeoutSec={activeSqlTab?.settings.timeoutSec ?? 30} onClose={() => setShowImport(false)} onImported={onImported} onOperationChange={onImportOperationChange} />
      {toast && <div className={`fixed bottom-9 right-4 z-50 max-w-[min(620px,calc(100vw-2rem))] rounded-xl border px-3 py-2 text-xs shadow-2xl backdrop-blur ${toast.tone === 'success' ? 'border-emerald-500/30 bg-emerald-950/90 text-emerald-200' : toast.tone === 'error' ? 'border-red-500/30 bg-red-950/90 text-red-200' : 'border-sky-500/30 bg-sky-950/90 text-sky-200'}`}>{toast.message}</div>}
    </div>
  );
}
