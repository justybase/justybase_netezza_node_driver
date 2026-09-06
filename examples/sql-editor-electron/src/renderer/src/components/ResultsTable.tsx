import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnFiltersState,
  type ExpandedState,
  type FilterFn,
  type GroupingState,
  type PaginationState,
  type Row,
  type SortingState
} from '@tanstack/react-table';
import type { NzField } from '../../../preload/api';
import { formatCell, typeShort } from '../lib/format';

interface Props {
  rows: Record<string, unknown>[];
  fields: NzField[];
}

type ResultRow = Record<string, unknown>;
type Selection = { anchorRow: number; anchorCol: number; focusRow: number; focusCol: number };

const textFilter: FilterFn<ResultRow> = (row, columnId, value) => {
  const needle = String(value ?? '').trim().toLocaleLowerCase();
  if (!needle) return true;
  return formatCell(row.getValue(columnId)).text.toLocaleLowerCase().includes(needle);
};

const globalTextFilter: FilterFn<ResultRow> = (row, _columnId, value) => {
  const needle = String(value ?? '').trim().toLocaleLowerCase();
  if (!needle) return true;
  return row.getAllCells().some((cell) => formatCell(cell.getValue()).text.toLocaleLowerCase().includes(needle));
};

function rangeContains(selection: Selection | null, row: number, column: number): boolean {
  if (!selection) return false;
  const minRow = Math.min(selection.anchorRow, selection.focusRow);
  const maxRow = Math.max(selection.anchorRow, selection.focusRow);
  const minCol = Math.min(selection.anchorCol, selection.focusCol);
  const maxCol = Math.max(selection.anchorCol, selection.focusCol);
  return row >= minRow && row <= maxRow && column >= minCol && column <= maxCol;
}

function selectedText(selection: Selection, leafRows: Array<{ getValue: (columnId: string) => unknown }>, fields: NzField[]): string {
  const minRow = Math.min(selection.anchorRow, selection.focusRow);
  const maxRow = Math.max(selection.anchorRow, selection.focusRow);
  const minCol = Math.min(selection.anchorCol, selection.focusCol);
  const maxCol = Math.max(selection.anchorCol, selection.focusCol);
  return leafRows.slice(minRow, maxRow + 1).map((row) =>
    fields.slice(minCol, maxCol + 1).map((field) => formatCell(row.getValue(field.name)).text).join('\t')
  ).join('\r\n');
}

export default function ResultsTable({ rows, fields }: Props) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 100 });
  const [globalFilter, setGlobalFilter] = useState('');
  const deferredGlobalFilter = useDeferredValue(globalFilter);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [showColumnFilters, setShowColumnFilters] = useState(false);
  const [grouping, setGrouping] = useState<GroupingState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [groupDropActive, setGroupDropActive] = useState(false);
  const selectingRef = useRef(false);
  const draggingColumnRef = useRef(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  selectionRef.current = selection;
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  const scrollFrame = () => {
    scrollRafRef.current = null;
    if (!selectingRef.current) return;
    const container = scrollRef.current;
    const pointer = pointerRef.current;
    if (container && pointer) {
      const rect = container.getBoundingClientRect();
      const EDGE = 48;
      const speed = (depth: number) => Math.min(1, depth / EDGE) * 18;
      let dx = 0;
      let dy = 0;
      if (pointer.y < rect.top + EDGE) dy = -speed(rect.top + EDGE - pointer.y);
      else if (pointer.y > rect.bottom - EDGE) dy = speed(pointer.y - (rect.bottom - EDGE));
      if (pointer.x < rect.left + EDGE) dx = -speed(rect.left + EDGE - pointer.x);
      else if (pointer.x > rect.right - EDGE) dx = speed(pointer.x - (rect.right - EDGE));
      if (dy !== 0) container.scrollTop += dy;
      if (dx !== 0) container.scrollLeft += dx;
    }
    scrollRafRef.current = requestAnimationFrame(scrollFrame);
  };

  const startAutoScroll = () => {
    if (scrollRafRef.current === null) scrollRafRef.current = requestAnimationFrame(scrollFrame);
  };

  const stopAutoScroll = () => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  };

  const columns = useMemo(
    () => fields.map((field) => ({
      id: field.name,
      accessorFn: (row: ResultRow) => row[field.name],
      filterFn: textFilter,
      enableGrouping: true,
      header: () => (
        <span className="flex flex-col items-start gap-0.5">
          <span className="font-mono font-semibold text-slate-200">{field.name}</span>
          <span className="rounded bg-slate-800 px-1 text-[10px] font-medium text-slate-500">{typeShort(field.dataTypeID)}</span>
        </span>
      ),
      cell: (ctx: { getValue: () => unknown }) => {
        const { text, isNull } = formatCell(ctx.getValue());
        return <span title={text} className={`block max-w-[320px] truncate font-mono text-xs ${isNull ? 'italic text-slate-600' : 'text-slate-300'}`}>{text}</span>;
      }
    })),
    [fields]
  );

  const table = useReactTable<ResultRow>({
    data: rows,
    columns,
    globalFilterFn: globalTextFilter,
    state: { sorting, pagination, globalFilter: deferredGlobalFilter, columnFilters, grouping, expanded },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    onColumnFiltersChange: setColumnFilters,
    onGroupingChange: setGrouping,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetExpanded: false
  });

  const rowModel = table.getRowModel();
  const visibleRows = rowModel.rows;
  const leafRows = useMemo(() => rowModel.flatRows.filter((row) => !row.getIsGrouped()), [rowModel]);
  const leafIndexById = useMemo(() => new Map(leafRows.map((row, index) => [row.id, index])), [leafRows]);
  const filteredCount = table.getFilteredRowModel().rows.length;
  const page = table.getState().pagination;

  useEffect(() => {
    setSorting([]);
    setColumnFilters([]);
    setGlobalFilter('');
    setGrouping([]);
    setExpanded(true);
    setSelection(null);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  }, [rows, fields]);

  useEffect(() => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
    setSelection(null);
  }, [deferredGlobalFilter, columnFilters, grouping]);

  useEffect(() => {
    setSelection(null);
  }, [page.pageIndex, page.pageSize]);

  useEffect(() => {
    const handleMouseUp = () => {
      selectingRef.current = false;
      stopAutoScroll();
    };
    const handleMouseMove = (event: MouseEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    const handleCopy = (event: ClipboardEvent) => {
      const current = selectionRef.current;
      if (!current || !gridRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', selectedText(current, leafRows, fields));
    };
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('copy', handleCopy);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('copy', handleCopy);
    };
  }, [fields, leafRows]);

  if (fields.length === 0) return <div className="p-6 text-center text-sm text-slate-500">The query returned no columns (e.g. DDL / INSERT). Check the Messages tab.</div>;

  const updateSelection = (rowIndex: number, columnIndex: number) => {
    setSelection((current) => current ? { ...current, focusRow: rowIndex, focusCol: columnIndex } : null);
  };

  const addGrouping = (columnId: string) => {
    if (!fields.some((field) => field.name === columnId)) return;
    if (!grouping.includes(columnId)) {
      setGrouping((current) => current.includes(columnId) ? current : [...current, columnId]);
      setExpanded({});
    }
  };

  const renderRows = (rowList: Row<ResultRow>[], depth = 0): ReactNode[] => rowList.flatMap((row) => {
    if (row.getIsGrouped()) {
      const columnId = row.groupingColumnId || grouping[0] || '';
      const groupRow = (
        <tr key={row.id} className="border-b border-indigo-500/10 bg-indigo-500/[0.06]">
          <td colSpan={fields.length + 1} className="px-3 py-1.5">
            <button onClick={() => row.toggleExpanded()} className="flex w-full items-center gap-2 text-left text-xs text-indigo-200" style={{ paddingLeft: `${depth * 14}px` }}>
              <span className="font-mono text-indigo-300">{row.getIsExpanded() ? '▾' : '▸'}</span>
              <span className="font-semibold">{columnId}</span>
              <span className="font-mono text-slate-300">{formatCell(row.getValue(columnId)).text}</span>
              <span className="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">COUNT {row.getLeafRows().length}</span>
            </button>
          </td>
        </tr>
      );
      return row.getIsExpanded() ? [groupRow, ...renderRows(row.subRows, depth + 1)] : [groupRow];
    }

    const rowIndex = leafIndexById.get(row.id) ?? 0;
    return [(
      <tr key={row.id} className={`border-b border-slate-800/50 transition hover:bg-indigo-500/[0.07] ${rowIndex % 2 === 1 ? 'bg-slate-900/40' : ''}`}>
        <td className="px-2 py-1.5 text-right font-mono text-[10px] text-slate-600">{page.pageIndex * page.pageSize + rowIndex + 1}</td>
        {row.getVisibleCells().map((cell) => {
          const fieldIndex = fields.findIndex((field) => field.name === cell.column.id);
          return (
            <td
              key={cell.id}
              onMouseDown={(event) => {
                if (event.button !== 0 || fieldIndex < 0) return;
                event.preventDefault();
                event.stopPropagation();
                gridRef.current?.focus();
                selectingRef.current = true;
                startAutoScroll();
                setSelection((current) => {
                  if (event.shiftKey && current) return { ...current, focusRow: rowIndex, focusCol: fieldIndex };
                  return { anchorRow: rowIndex, anchorCol: fieldIndex, focusRow: rowIndex, focusCol: fieldIndex };
                });
              }}
              onMouseEnter={() => { if (selectingRef.current && fieldIndex >= 0) updateSelection(rowIndex, fieldIndex); }}
              className={`select-none px-3 py-1.5 ${rangeContains(selection, rowIndex, fieldIndex) ? 'bg-indigo-500/30 text-white outline outline-1 -outline-offset-1 outline-indigo-400/70' : ''}`}
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </td>
          );
        })}
      </tr>
    )];
  });

  return (
    <div
      ref={gridRef}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col outline-none"
      onMouseDown={(event) => { if (event.target === event.currentTarget) event.currentTarget.focus(); }}
    >
      <div
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-nz-column') || event.dataTransfer.types.includes('text/plain')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setGroupDropActive(true);
          }
        }}
        onDragLeave={() => setGroupDropActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          addGrouping(event.dataTransfer.getData('application/x-nz-column') || event.dataTransfer.getData('text/plain'));
          setGroupDropActive(false);
        }}
        className={`mx-3 mt-2 flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 rounded-xl border border-dashed px-2.5 py-1.5 transition ${groupDropActive ? 'border-indigo-400 bg-indigo-500/15' : 'border-slate-700 bg-slate-900/60'}`}
      >
        <span className="mr-1 text-[11px] font-medium text-slate-500">Group by</span>
        {grouping.length === 0 ? <span className="text-[11px] text-slate-600">Drag a column header here</span> : grouping.map((columnId) => (
          <div
            key={columnId}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('application/x-nz-group', columnId);
            }}
            onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-nz-group')) event.preventDefault(); }}
            onDrop={(event) => {
              event.preventDefault();
              const moved = event.dataTransfer.getData('application/x-nz-group');
              if (!moved || moved === columnId) return;
              setGrouping((current) => {
                const next = current.filter((value) => value !== moved);
                const targetIndex = next.indexOf(columnId);
                next.splice(targetIndex < 0 ? next.length : targetIndex, 0, moved);
                return next;
              });
            }}
            className="flex items-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[11px] text-indigo-200"
          >
            <span>{columnId}</span>
            <button onClick={() => setGrouping((current) => current.filter((value) => value !== columnId))} className="ml-1 text-indigo-300/60 hover:text-white" aria-label={`Remove ${columnId}`}>×</button>
          </div>
        ))}
        {grouping.length > 0 && <button onClick={() => setGrouping([])} className="ml-auto rounded px-1.5 py-1 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-slate-200">Clear groups</button>}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/70 px-3 py-2">
        <div className="relative min-w-[190px] flex-1 sm:max-w-[340px]">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600">⌕</span>
          <input value={globalFilter} onChange={(event) => setGlobalFilter(event.target.value)} placeholder="Filter all columns…" className="w-full rounded-lg border border-slate-800 bg-slate-950 py-1.5 pl-7 pr-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-indigo-500/60" />
        </div>
        <button onClick={() => setShowColumnFilters((current) => !current)} className={`rounded-lg border px-2.5 py-1.5 text-[11px] transition ${showColumnFilters ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-200' : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-600 hover:text-slate-200'}`}>≡ Column filters</button>
        {selection && <span className="rounded-md bg-indigo-500/10 px-2 py-1 text-[10px] text-indigo-200">{Math.abs(selection.focusRow - selection.anchorRow) + 1} × {Math.abs(selection.focusCol - selection.anchorCol) + 1} selected · Ctrl/Cmd+C</span>}
        {(globalFilter || columnFilters.length > 0) && <button onClick={() => { setGlobalFilter(''); setColumnFilters([]); }} className="rounded-lg px-2 py-1.5 text-[11px] text-slate-500 transition hover:bg-slate-800 hover:text-slate-200">Clear</button>}
        <span className="ml-auto font-mono text-[11px] text-slate-500">{filteredCount.toLocaleString()} / {rows.length.toLocaleString()} rows</span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-slate-900 shadow-[0_1px_0_#1e293b]">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                <th className="w-12 border-b border-slate-800 px-2 py-2 text-[10px] font-medium text-slate-600">#</th>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    draggable
                    onDragStart={(event) => {
                      draggingColumnRef.current = true;
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData('application/x-nz-column', header.column.id);
                      event.dataTransfer.setData('text/plain', header.column.id);
                    }}
                    onDragEnd={() => { draggingColumnRef.current = false; setGroupDropActive(false); }}
                    onClick={(event) => {
                      if (draggingColumnRef.current) {
                        draggingColumnRef.current = false;
                        return;
                      }
                      header.column.getToggleSortingHandler()?.(event);
                    }}
                    className="cursor-grab select-none border-b border-slate-800 px-3 py-2 align-top transition hover:bg-slate-800/50 active:cursor-grabbing"
                  >
                    <span className="flex items-start gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <span className="mt-0.5 text-[10px] text-indigo-400">{header.column.getIsSorted() === 'asc' ? '▲' : header.column.getIsSorted() === 'desc' ? '▼' : ''}</span>
                    </span>
                  </th>
                ))}
              </tr>
            ))}
            {showColumnFilters && table.getHeaderGroups().map((headerGroup) => (
              <tr key={`${headerGroup.id}-filters`}>
                <th className="border-b border-slate-800 px-2 py-1" />
                {headerGroup.headers.map((header) => (
                  <th key={`${header.id}-filter`} className="border-b border-slate-800 px-2 py-1">
                    <input value={(header.column.getFilterValue() as string) ?? ''} onClick={(event) => event.stopPropagation()} onChange={(event) => header.column.setFilterValue(event.target.value)} placeholder="contains…" className="w-full min-w-[90px] rounded border border-slate-800 bg-slate-950 px-1.5 py-1 font-normal text-[10px] text-slate-300 outline-none placeholder:text-slate-700 focus:border-indigo-500/60" />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {renderRows(visibleRows)}
          </tbody>
        </table>
        {rows.length === 0 ? <div className="p-6 text-center text-sm text-slate-500">Empty result — 0 rows.</div> : filteredCount === 0 ? <div className="p-6 text-center text-sm text-slate-500">No rows match the current filters.</div> : null}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-400">
        <button onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()} className="rounded px-1.5 py-0.5 hover:bg-slate-800 disabled:opacity-30">⏮</button>
        <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} className="rounded px-1.5 py-0.5 hover:bg-slate-800 disabled:opacity-30">◀</button>
        <span className="font-mono">{page.pageIndex + 1} / {Math.max(1, table.getPageCount())}</span>
        <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} className="rounded px-1.5 py-0.5 hover:bg-slate-800 disabled:opacity-30">▶</button>
        <button onClick={() => table.setPageIndex(Math.max(0, table.getPageCount() - 1))} disabled={!table.getCanNextPage()} className="rounded px-1.5 py-0.5 hover:bg-slate-800 disabled:opacity-30">⏭</button>
        <span className="ml-2 text-slate-600">·</span>
        <span>{filteredCount.toLocaleString()} shown</span>
        <select value={page.pageSize} onChange={(event) => setPagination((current) => ({ ...current, pageIndex: 0, pageSize: Number(event.target.value) }))} className="ml-auto rounded-md border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[11px] outline-none">
          {[50, 100, 250, 500].map((size) => <option key={size} value={size}>{size} / page</option>)}
        </select>
      </div>
    </div>
  );
}
