import { useEffect, useMemo, useState } from 'react';
import type { NzColumn, NzImportColumn, NzImportPreview, NzImportPreviewResult, NzImportProgress, NzImportResult, NzOperationKind } from '../../../preload/api';

interface Props {
  open: boolean;
  connected: boolean;
  database?: string;
  timeoutSec: number;
  onClose: () => void;
  onImported: (result: NzImportResult) => void;
  onOperationChange: (operation: { id: string; kind: NzOperationKind; label: string } | null) => void;
}

const TYPE_OPTIONS = ['INTEGER', 'BIGINT', 'NUMERIC(18,2)', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'NVARCHAR(255)', 'NVARCHAR(1024)', 'NVARCHAR(4000)'];

function defaultTableName(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'IMPORTED_DATA';
  const clean = name.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return clean && !/^\d/.test(clean) ? clean : 'IMPORTED_DATA';
}

function targetParts(target: string): { schema?: string; table: string; database?: string } {
  const parts = target.split('.').map((part) => part.trim()).filter(Boolean);
  return {
    database: parts.length === 3 ? parts[0] : undefined,
    schema: parts.length >= 2 ? parts[parts.length - 2] : undefined,
    table: parts[parts.length - 1] || ''
  };
}

function displayDelimiter(delimiter?: string): string {
  return delimiter === '\t' ? 'TAB' : delimiter || '—';
}

function operationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function ImportWizard({ open, connected, database, timeoutSec, onClose, onImported, onOperationChange }: Props) {
  const [preview, setPreview] = useState<NzImportPreview | null>(null);
  const [columns, setColumns] = useState<NzImportColumn[]>([]);
  const [targetTable, setTargetTable] = useState('');
  const [mode, setMode] = useState<'create' | 'append'>('create');
  const [targetColumns, setTargetColumns] = useState<NzColumn[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<NzImportProgress | null>(null);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setColumns([]);
    setTargetTable('');
    setMode('create');
    setTargetColumns([]);
    setBusy(false);
    setLoadingTarget(false);
    setError(null);
    setProgress(null);
    setActiveOperationId(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return window.nz.onOperationProgress((next) => {
      if (next.kind === 'import' || next.kind === 'import-preview') setProgress(next);
    });
  }, [open]);

  const loadPreview = async (filePath: string, options?: { sheetName?: string; hasHeader?: boolean; delimiter?: string }, resetTarget = true) => {
    setError(null);
    setBusy(true);
    const currentOperationId = operationId('import-preview');
    setActiveOperationId(currentOperationId);
    onOperationChange({ id: currentOperationId, kind: 'import-preview', label: 'preview' });
    try {
      const next: NzImportPreviewResult = await window.nz.previewImport({ operationId: currentOperationId, filePath, ...options });
      if (!('columns' in next)) {
        setError(next.message);
        return;
      }
      setPreview(next);
      setColumns(next.columns);
      if (resetTarget || !targetTable.trim()) setTargetTable(defaultTableName(filePath));
      setTargetColumns([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setActiveOperationId(null);
      onOperationChange(null);
    }
  };

  const chooseFile = async () => {
    const selected = await window.nz.pickImportFile();
    if (!selected.canceled && selected.filePath) await loadPreview(selected.filePath);
  };

  const refreshPreview = async (next: { sheetName?: string; hasHeader?: boolean; delimiter?: string }) => {
    if (!preview) return;
    await loadPreview(preview.filePath, {
      sheetName: next.sheetName ?? preview.selectedSheet,
      hasHeader: next.hasHeader ?? preview.hasHeader,
      delimiter: next.delimiter ?? preview.delimiter
    }, false);
  };

  const loadTargetColumns = async () => {
    if (!targetTable.trim()) return;
    const parts = targetParts(targetTable);
    if (!parts.table) return;
    setLoadingTarget(true);
    setError(null);
    try {
      const next = await window.nz.columns({ database: parts.database || database, schema: parts.schema, table: parts.table });
      setTargetColumns(next);
      if (next.length === 0) setError('Target table has no visible columns. Check the name and permissions.');
      setColumns((current) => current.map((column) => {
        const match = next.find((candidate) => candidate.name.toUpperCase() === column.targetName.toUpperCase() || candidate.name.toUpperCase() === column.sourceName.toUpperCase());
        return match ? { ...column, targetName: match.name, selected: true, targetType: match.type } : { ...column, targetName: '', selected: false };
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingTarget(false);
    }
  };

  const updateColumn = (sourceIndex: number, patch: Partial<NzImportColumn>) => {
    setColumns((current) => current.map((column) => column.sourceIndex === sourceIndex ? { ...column, ...patch } : column));
  };

  const selectedCount = useMemo(() => columns.filter((column) => column.selected).length, [columns]);

  const runImport = async () => {
    if (!preview || !connected || !targetTable.trim() || selectedCount === 0 || busy) return;
    if (mode === 'append' && targetColumns.length === 0) {
      await loadTargetColumns();
      return;
    }
    setBusy(true);
    setError(null);
    const currentOperationId = operationId('import');
    setProgress({ operationId: currentOperationId, kind: 'import', phase: 'load', message: 'Starting import…', percent: 0 });
    setActiveOperationId(currentOperationId);
    onOperationChange({ id: currentOperationId, kind: 'import', label: 'import' });
    try {
      const result = await window.nz.importFile({
        operationId: currentOperationId,
        filePath: preview.filePath,
        format: preview.format,
        sheetName: preview.selectedSheet,
        hasHeader: preview.hasHeader,
        delimiter: preview.delimiter,
        targetTable: targetTable.trim(),
        mode,
        rowCount: preview.rowCount,
        timeoutSec,
        columns: columns.map((column) => ({
          sourceIndex: column.sourceIndex,
          targetName: column.targetName.trim(),
          dataType: column.inferredType,
          selected: column.selected
        }))
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onImported(result);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setActiveOperationId(null);
      onOperationChange(null);
    }
  };

  const cancelCurrentOperation = async () => {
    if (!activeOperationId) return;
    setProgress((current) => current ? { ...current, message: 'Canceling operation…' } : { operationId: activeOperationId, kind: 'import', phase: 'load', message: 'Canceling operation…' });
    await window.nz.cancel(activeOperationId).catch(() => undefined);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => { if (!busy) onClose(); }}>
      <div className="flex max-h-[min(850px,calc(100vh-2rem))] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-900 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-slate-800 bg-gradient-to-r from-emerald-500/10 to-cyan-400/10 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Import data into Netezza</h2>
            <p className="mt-0.5 text-xs text-slate-400">CSV, XLSX and XLSB · streamed through the driver’s external-table protocol</p>
          </div>
          <button disabled={busy} onClick={onClose} className="ml-auto rounded-lg px-2 py-1 text-lg text-slate-500 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40">×</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (!file) return;
              const path = window.nz.getDroppedFilePath(file);
              void loadPreview(path);
            }}
            className="flex items-center gap-3 rounded-xl border border-dashed border-slate-700 bg-slate-950/60 px-4 py-3"
          >
            <button onClick={() => void chooseFile()} disabled={busy} className="rounded-lg bg-indigo-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-40">Choose file</button>
            <div className="min-w-0 flex-1 text-xs text-slate-500">{preview ? <><span className="font-mono text-slate-300">{preview.fileName}</span> · {preview.format.toUpperCase()} · {preview.rowCount.toLocaleString()} data rows</> : 'or drop a .csv, .xlsx or .xlsb file here'}</div>
            {preview && <span className="rounded-md bg-slate-800 px-2 py-1 text-[10px] text-slate-400">{displayDelimiter(preview.delimiter)}</span>}
          </div>

          {preview && (
            <>
              <div className="mt-4 grid gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3 md:grid-cols-4">
                {preview.format !== 'csv' && <label className="text-[11px] text-slate-500">Worksheet<select value={preview.selectedSheet || ''} onChange={(event) => void refreshPreview({ sheetName: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none"><option value="">First sheet</option>{preview.sheetNames.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}</select></label>}
                {preview.format === 'csv' && <label className="text-[11px] text-slate-500">Delimiter<select value={preview.delimiter || ','} onChange={(event) => void refreshPreview({ delimiter: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none"><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value="\t">Tab</option><option value="|">Pipe (|)</option></select></label>}
                <label className="flex items-center gap-2 self-end pb-1 text-[11px] text-slate-400"><input type="checkbox" checked={preview.hasHeader} onChange={(event) => void refreshPreview({ hasHeader: event.target.checked })} className="accent-indigo-500" /> First row is header</label>
                <div className="self-end text-[11px] text-slate-500">{preview.columns.length} columns · {selectedCount} selected</div>
                <button onClick={() => void refreshPreview({})} disabled={busy} className="self-end rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-40">Refresh preview</button>
              </div>

              <div className="mt-4 overflow-hidden rounded-xl border border-slate-800">
                <div className="border-b border-slate-800 bg-slate-900/70 px-3 py-2 text-[11px] font-medium text-slate-400">Preview</div>
                <div className="max-h-44 overflow-auto">
                  <table className="w-full border-collapse text-left text-[11px]"><thead className="sticky top-0 bg-slate-900"><tr>{preview.columns.map((column) => <th key={column.sourceIndex} className="border-b border-slate-800 px-2 py-1.5 font-mono text-slate-300">{column.sourceName}</th>)}</tr></thead><tbody>{preview.sampleRows.map((row, rowIndex) => <tr key={rowIndex} className="border-b border-slate-800/50">{preview.columns.map((column) => <td key={column.sourceIndex} className="max-w-[220px] truncate px-2 py-1 font-mono text-slate-500">{row[column.sourceIndex] || ''}</td>)}</tr>)}</tbody></table>
                </div>
              </div>

              <div className="mt-4 overflow-hidden rounded-xl border border-slate-800">
                <div className="border-b border-slate-800 bg-slate-900/70 px-3 py-2 text-[11px] font-medium text-slate-400">Columns and types</div>
                <div className="max-h-60 overflow-auto"><table className="w-full border-collapse text-left text-[11px]"><thead className="sticky top-0 bg-slate-900"><tr><th className="w-8 px-2 py-1.5" /><th className="px-2 py-1.5 text-slate-500">Source</th><th className="px-2 py-1.5 text-slate-500">Target column</th><th className="px-2 py-1.5 text-slate-500">Type</th><th className="px-2 py-1.5 text-slate-500">Samples</th></tr></thead><tbody>{columns.map((column) => <tr key={column.sourceIndex} className="border-t border-slate-800/50"><td className="px-2 py-1.5"><input type="checkbox" checked={column.selected} onChange={(event) => updateColumn(column.sourceIndex, { selected: event.target.checked })} className="accent-emerald-500" /></td><td className="px-2 py-1.5 font-mono text-slate-300">{column.sourceName}</td><td className="px-2 py-1.5">{mode === 'append' ? <select value={column.targetName} onChange={(event) => updateColumn(column.sourceIndex, { targetName: event.target.value, selected: event.target.value.length > 0 })} className="w-full min-w-32 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"><option value="">Skip</option>{targetColumns.map((target) => <option key={target.name} value={target.name}>{target.name}</option>)}</select> : <input value={column.targetName} onChange={(event) => updateColumn(column.sourceIndex, { targetName: event.target.value })} className="w-full min-w-32 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-indigo-500" />}</td><td className="px-2 py-1.5">{mode === 'append' && column.targetType ? <span className="font-mono text-slate-400">{column.targetType}</span> : <select value={column.inferredType} onChange={(event) => updateColumn(column.sourceIndex, { inferredType: event.target.value })} className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200">{Array.from(new Set([column.inferredType, ...TYPE_OPTIONS])).map((type) => <option key={type} value={type}>{type}</option>)}</select>}</td><td className="max-w-56 truncate px-2 py-1.5 font-mono text-slate-600">{column.sampleValues.join(' · ')}</td></tr>)}</tbody></table></div>
              </div>

              <div className="mt-4 grid gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3 md:grid-cols-[1fr_auto]">
                <label className="text-[11px] text-slate-500">Target table<span className="mt-1 flex gap-2"><input value={targetTable} onChange={(event) => setTargetTable(event.target.value)} onBlur={() => { if (mode === 'append') void loadTargetColumns(); }} placeholder="SCHEMA.TABLE or TABLE" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500" />{mode === 'append' && <button onClick={() => void loadTargetColumns()} disabled={loadingTarget || !targetTable.trim()} className="rounded-lg border border-slate-700 px-2.5 text-[11px] text-slate-400 hover:border-slate-500 hover:text-white disabled:opacity-40">{loadingTarget ? '…' : 'Load columns'}</button>}</span></label>
                <label className="text-[11px] text-slate-500">Mode<select value={mode} onChange={(event) => { const next = event.target.value as 'create' | 'append'; setMode(next); if (next === 'append') void loadTargetColumns(); }} className="mt-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-slate-200 outline-none"><option value="create">Create new table</option><option value="append">Append to existing</option></select></label>
              </div>
              {mode === 'append' && targetColumns.length > 0 && <div className="mt-2 text-[11px] text-emerald-300/80">Loaded {targetColumns.length} target columns. Unmapped source columns are skipped.</div>}
            </>
          )}

          {!connected && <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-200">Connect to Netezza before importing. Preview works offline.</div>}
          {error && <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-xs text-red-200">{error}</div>}
          {progress && busy && <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.07] px-3 py-2 text-xs text-indigo-200"><div className="flex justify-between gap-3"><span>{progress.message}</span><span>{progress.percent !== undefined ? `${Math.round(progress.percent)}%` : '…'}</span></div><div className="mt-2 h-1 overflow-hidden rounded bg-slate-800"><div className="h-full rounded bg-indigo-400 transition-all" style={{ width: `${Math.max(3, Math.min(100, progress.percent ?? 8))}%` }} /></div></div>}
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 bg-slate-950/60 px-5 py-3"><span className="text-[11px] text-slate-600">Netezza external load · target is quoted safely</span><div className="flex gap-2"><button disabled={!busy && !activeOperationId} onClick={() => { if (busy) void cancelCurrentOperation(); else onClose(); }} className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40">{busy ? 'Cancel operation' : 'Close'}</button><button disabled={busy || !preview || !connected || !targetTable.trim() || selectedCount === 0} onClick={() => void runImport()} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 disabled:opacity-40">{busy ? 'Importing…' : 'Import data'}</button></div></div>
      </div>
    </div>
  );
}
