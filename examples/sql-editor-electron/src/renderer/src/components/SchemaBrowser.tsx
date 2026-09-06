import { useEffect, useMemo, useState } from 'react';
import type { NzColumn, NzSchemaNode } from '../../../preload/api';

interface Props {
  schemas: NzSchemaNode[];
  loading: boolean;
  connected: boolean;
  warning?: string;
  onRefresh: () => void;
  onPickTable: (schema: string, table: string, kind: 'TABLE' | 'VIEW') => void;
  onShowColumns: (schema: string, table: string) => void;
  onLoadColumns: (schema: string, table: string) => Promise<NzColumn[]>;
}

export default function SchemaBrowser({ schemas, loading, connected, warning, onRefresh, onPickTable, onShowColumns, onLoadColumns }: Props) {
  const [filter, setFilter] = useState('');
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});
  const [loadingTables, setLoadingTables] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (schemas.length === 0) return;
    setOpenSchemas((current) => (Object.keys(current).length > 0 ? current : { [schemas[0].name]: true }));
  }, [schemas]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return schemas;
    return schemas
      .map((s) => ({
        ...s,
        tables: s.tables.filter((t) => t.name.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      }))
      .filter((s) => s.name.toLowerCase().includes(q) || s.tables.length > 0);
  }, [schemas, filter]);

  const totalTables = schemas.reduce((n, s) => n + s.tables.length, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600">⌕</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search tables…"
            className="w-full rounded-lg border border-slate-800 bg-slate-950 py-1.5 pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/60"
          />
        </div>
        <button
          onClick={onRefresh}
          disabled={!connected || loading}
          title="Refresh schema"
          className="rounded-lg border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs text-slate-400 transition hover:border-slate-600 hover:text-slate-200 disabled:opacity-40"
        >
          ⟳
        </button>
      </div>

      <div className="flex items-center justify-between px-3 pb-1 text-[11px] text-slate-500">
        <span>
          {schemas.length} schemas · {totalTables} objects
        </span>
      </div>

      {warning && <div className="mx-3 mb-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">{warning}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {!connected ? (
          <div className="mx-1.5 rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-4 text-center">
            <div className="text-lg">🗄️</div>
            <div className="mt-1 text-xs font-medium text-slate-300">Connect to the database</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
              The schema (DB.._V_SCHEMA, _V_OBJECT_DATA…) appears after connecting.
            </div>
          </div>
        ) : loading ? (
          <div className="space-y-1.5 p-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-7 animate-pulse rounded-lg bg-slate-800/60" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-slate-500">No results{filter ? ` for “${filter}”` : ''}.</div>
        ) : (
          filtered.map((s) => {
            const open = openSchemas[s.name] ?? false;
            return (
              <div key={s.name} className="mb-0.5">
                <button
                  onClick={() => setOpenSchemas((p) => ({ ...p, [s.name]: !open }))}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-slate-800/60"
                >
                  <span className={`text-[10px] text-slate-600 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
                  <span className="text-sm">🗂️</span>
                  <span className="truncate font-mono font-semibold text-slate-200">{s.name}</span>
                  <span className="ml-auto rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">{s.tables.length}</span>
                </button>
                {open && (
                  <div className="ml-4 border-l border-slate-800/80 pl-1">
                    {s.tables.length === 0 && <div className="px-2 py-1 text-[11px] italic text-slate-600">empty schema</div>}
                    {s.tables.map((t) => {
                      const key = `${s.name}.${t.name}`;
                      const tOpen = openTables[key] ?? false;
                      const tLoading = loadingTables[key] ?? false;
                      const toggleTable = async () => {
                        const nextOpen = !tOpen;
                        setOpenTables((current) => ({ ...current, [key]: nextOpen }));
                        if (!nextOpen || t.columns.length > 0 || tLoading) return;
                        setLoadingTables((current) => ({ ...current, [key]: true }));
                        try {
                          await onLoadColumns(s.name, t.name);
                        } finally {
                          setLoadingTables((current) => ({ ...current, [key]: false }));
                        }
                      };
                      return (
                        <div key={key}>
                          <div className="group flex items-center gap-1 rounded-md px-1.5 py-1 transition hover:bg-slate-800/60">
                            <button
                              onClick={() => void toggleTable()}
                              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                              title={`${t.kind} ${s.name}.${t.name}`}
                            >
                              <span className="text-xs">{t.kind === 'VIEW' ? '👁️' : '▭'}</span>
                              <span className="truncate font-mono text-[12px] text-slate-300">{t.name}</span>
                            </button>
                            <button
                              onClick={() => onPickTable(s.name, t.name, t.kind)}
                              title="Insert SELECT * LIMIT 100"
                              className="rounded px-1 text-[11px] text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-indigo-500/20 hover:text-indigo-300"
                            >
                              ▶
                            </button>
                            <button
                              onClick={() => onShowColumns(s.name, t.name)}
                              title="Show columns"
                              className="rounded px-1 text-[11px] text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-slate-700 hover:text-slate-200"
                            >
                              ≣
                            </button>
                          </div>
                          {tOpen && (
                            <div className="ml-6 border-l border-slate-800/50 pl-3">
                              {tLoading ? (
                                <div className="px-1 py-1 text-[10px] text-slate-600">Loading columns…</div>
                              ) : t.columns.length > 0 ? (
                                t.columns.map((column) => (
                                  <div key={`${key}.${column.name}`} className="flex items-center gap-2 py-0.5 text-[10px]">
                                    <span className="font-mono text-slate-400">{column.name}</span>
                                    <span className="truncate text-slate-600">{column.type}</span>
                                  </div>
                                ))
                              ) : (
                                <div className="px-1 py-1 text-[10px] italic text-slate-600">No column metadata available</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
