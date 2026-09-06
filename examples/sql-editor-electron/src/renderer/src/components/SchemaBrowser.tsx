import { useEffect, useMemo, useState } from 'react';
import type { NzColumn, NzSchemaNode, NzSchemaObject } from '../../../preload/api';

interface Props {
  schemas: NzSchemaNode[];
  loading: boolean;
  connected: boolean;
  warning?: string;
  onRefresh: () => void;
  onPickTable: (schema: string, table: string, kind: string) => void;
  onShowColumns: (schema: string, table: string) => void;
  onLoadColumns: (schema: string, table: string) => Promise<NzColumn[]>;
  onPreviewObject: (schema: string, name: string, kind: 'VIEW' | 'PROCEDURE') => void;
}

type ObjectGroupId = 'tables' | 'views' | 'materialized-views' | 'external-tables' | 'synonyms' | 'sequences' | 'procedures' | 'functions' | 'aggregates' | 'other';

const GROUP_ORDER: ObjectGroupId[] = [
  'tables',
  'views',
  'materialized-views',
  'external-tables',
  'synonyms',
  'sequences',
  'procedures',
  'functions',
  'aggregates',
  'other'
];

const GROUP_META: Record<ObjectGroupId, { label: string; icon: string }> = {
  tables: { label: 'Tables', icon: '▭' },
  views: { label: 'Views', icon: '👁️' },
  'materialized-views': { label: 'Materialized views', icon: '◉' },
  'external-tables': { label: 'External tables', icon: '⇄' },
  synonyms: { label: 'Synonyms', icon: '↗' },
  sequences: { label: 'Sequences', icon: '#' },
  procedures: { label: 'Procedures', icon: 'ƒ' },
  functions: { label: 'Functions', icon: 'λ' },
  aggregates: { label: 'Aggregates', icon: '∑' },
  other: { label: 'Other objects', icon: '◈' }
};

interface ObjectGroup {
  id: ObjectGroupId;
  label: string;
  icon: string;
  objects: NzSchemaObject[];
}

function normalizedKind(kind: string): string {
  return kind.trim().replace(/[\s_-]+/g, ' ').toUpperCase();
}

function groupIdForKind(kind: string): ObjectGroupId {
  switch (normalizedKind(kind)) {
    case 'TABLE':
      return 'tables';
    case 'VIEW':
      return 'views';
    case 'MATERIALIZED VIEW':
    case 'MATERIALIZEDVIEW':
      return 'materialized-views';
    case 'EXTERNAL TABLE':
      return 'external-tables';
    case 'SYNONYM':
      return 'synonyms';
    case 'SEQUENCE':
      return 'sequences';
    case 'PROCEDURE':
      return 'procedures';
    case 'FUNCTION':
    case 'UDF':
      return 'functions';
    case 'AGGREGATE':
      return 'aggregates';
    default:
      return 'other';
  }
}

function groupObjects(objects: NzSchemaObject[]): ObjectGroup[] {
  const grouped = new Map<ObjectGroupId, NzSchemaObject[]>();
  for (const object of objects) {
    const id = groupIdForKind(object.kind);
    const current = grouped.get(id) ?? [];
    current.push(object);
    grouped.set(id, current);
  }
  return GROUP_ORDER
    .filter((id) => (grouped.get(id)?.length ?? 0) > 0)
    .map((id) => ({ id, ...GROUP_META[id], objects: grouped.get(id) ?? [] }));
}

function canBrowseColumns(kind: string): boolean {
  return ['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'EXTERNAL TABLE', 'SYNONYM'].includes(normalizedKind(kind));
}

function previewKindForObject(kind: string): 'VIEW' | 'PROCEDURE' | null {
  const normalized = normalizedKind(kind);
  return normalized === 'VIEW' || normalized === 'PROCEDURE' ? normalized : null;
}

export default function SchemaBrowser({ schemas, loading, connected, warning, onRefresh, onPickTable, onShowColumns, onLoadColumns, onPreviewObject }: Props) {
  const [filter, setFilter] = useState('');
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [openObjects, setOpenObjects] = useState<Record<string, boolean>>({});
  const [loadingObjects, setLoadingObjects] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (schemas.length === 0) return;
    setOpenSchemas((current) => (Object.keys(current).length > 0 ? current : { [schemas[0].name]: true }));
  }, [schemas]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return schemas;
    return schemas
      .map((schema) => {
        const schemaMatches = schema.name.toLowerCase().includes(q);
        return {
          ...schema,
          objects: schemaMatches
            ? schema.objects
            : schema.objects.filter((object) => object.name.toLowerCase().includes(q) || object.kind.toLowerCase().includes(q))
        };
      })
      .filter((schema) => schema.objects.length > 0 || schema.name.toLowerCase().includes(q));
  }, [schemas, filter]);

  const totalObjects = schemas.reduce((count, schema) => count + schema.objects.length, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600">⌕</span>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search objects…"
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
        <span>{schemas.length} schemas · {totalObjects} objects</span>
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
            {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-7 animate-pulse rounded-lg bg-slate-800/60" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-slate-500">No results{filter ? ` for “${filter}”` : ''}.</div>
        ) : (
          filtered.map((schema) => {
            const schemaOpen = openSchemas[schema.name] ?? false;
            const groups = groupObjects(schema.objects);
            return (
              <div key={schema.name} className="mb-0.5">
                <button
                  onClick={() => setOpenSchemas((current) => ({ ...current, [schema.name]: !schemaOpen }))}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-slate-800/60"
                >
                  <span className={`text-[10px] text-slate-600 transition-transform ${schemaOpen ? 'rotate-90' : ''}`}>▶</span>
                  <span className="text-sm">🗂️</span>
                  <span className="truncate font-mono font-semibold text-slate-200">{schema.name}</span>
                  <span className="ml-auto rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">{schema.objects.length}</span>
                </button>
                {schemaOpen && (
                  <div className="ml-4 border-l border-slate-800/80 pl-1">
                    {groups.length === 0 && <div className="px-2 py-1 text-[11px] italic text-slate-600">empty schema</div>}
                    {groups.map((group) => {
                      const groupKey = `${schema.name}.${group.id}`;
                      const groupOpen = openGroups[groupKey] ?? true;
                      return (
                        <div key={group.id}>
                          <button
                            onClick={() => setOpenGroups((current) => ({ ...current, [groupKey]: !groupOpen }))}
                            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] font-medium text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-200"
                          >
                            <span className={`text-[9px] text-slate-600 transition-transform ${groupOpen ? 'rotate-90' : ''}`}>▶</span>
                            <span className="w-4 text-center">{group.icon}</span>
                            <span>{group.label}</span>
                            <span className="ml-auto rounded-full bg-slate-800/80 px-1.5 py-0.5 text-[10px] text-slate-500">{group.objects.length}</span>
                          </button>
                          {groupOpen && group.objects.map((object) => {
                            const objectKey = `${schema.name}.${object.kind}.${object.name}`;
                            const objectOpen = openObjects[objectKey] ?? false;
                            const objectLoading = loadingObjects[objectKey] ?? false;
                            const relation = canBrowseColumns(object.kind);
                            const previewKind = previewKindForObject(object.kind);
                            const toggleObject = async () => {
                              if (!relation) return;
                              const nextOpen = !objectOpen;
                              setOpenObjects((current) => ({ ...current, [objectKey]: nextOpen }));
                              if (!nextOpen || object.columns.length > 0 || objectLoading) return;
                              setLoadingObjects((current) => ({ ...current, [objectKey]: true }));
                              try {
                                await onLoadColumns(schema.name, object.name);
                              } finally {
                                setLoadingObjects((current) => ({ ...current, [objectKey]: false }));
                              }
                            };
                            return (
                              <div key={objectKey}>
                                <div className="group flex items-center gap-1 rounded-md px-1.5 py-1 transition hover:bg-slate-800/60">
                                  {relation ? (
                                    <button
                                      onClick={() => void toggleObject()}
                                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                      title={`${object.kind} ${schema.name}.${object.name}`}
                                    >
                                      <span className={`w-3 text-[9px] text-slate-600 transition-transform ${objectOpen ? 'rotate-90' : ''}`}>▶</span>
                                      <span className="truncate font-mono text-[12px] text-slate-300">{object.name}</span>
                                    </button>
                                  ) : (
                                    <div className="flex min-w-0 flex-1 items-center gap-1.5" title={`${object.kind} ${schema.name}.${object.name}`}>
                                      <span className="w-3" />
                                      <span className="truncate font-mono text-[12px] text-slate-300">{object.name}</span>
                                    </div>
                                  )}
                                  {previewKind && (
                                    <button
                                      onClick={() => onPreviewObject(schema.name, object.name, previewKind)}
                                      title={`Open ${previewKind.toLowerCase()} definition`}
                                      className="rounded px-1 text-[11px] text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-sky-500/20 hover:text-sky-300"
                                    >
                                      {'{}'}
                                    </button>
                                  )}
                                  {relation && (
                                    <>
                                      <button
                                        onClick={() => onPickTable(schema.name, object.name, object.kind)}
                                        title="Insert SELECT * LIMIT 100"
                                        className="rounded px-1 text-[11px] text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-indigo-500/20 hover:text-indigo-300"
                                      >
                                        ▶
                                      </button>
                                      <button
                                        onClick={() => onShowColumns(schema.name, object.name)}
                                        title="Show columns"
                                        className="rounded px-1 text-[11px] text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-slate-700 hover:text-slate-200"
                                      >
                                        ≣
                                      </button>
                                    </>
                                  )}
                                </div>
                                {relation && objectOpen && (
                                  <div className="ml-8 border-l border-slate-800/50 pl-3">
                                    {objectLoading ? (
                                      <div className="px-1 py-1 text-[10px] text-slate-600">Loading columns…</div>
                                    ) : object.columns.length > 0 ? (
                                      object.columns.map((column) => (
                                        <div key={`${objectKey}.${column.name}`} className="flex items-center gap-2 py-0.5 text-[10px]">
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
