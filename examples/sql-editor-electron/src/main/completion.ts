export type CompletionKind = 'keyword' | 'database' | 'schema' | 'table' | 'view' | 'column' | 'cte' | 'temp-table' | 'alias';

export interface CompletionItem {
  label: string;
  insertText?: string;
  detail?: string;
  kind: CompletionKind;
  sortText?: string;
}

export interface CompletionColumn {
  name: string;
  type: string;
}

export interface CompletionTable {
  name: string;
  kind: 'TABLE' | 'VIEW';
  schema: string;
  columns?: CompletionColumn[];
}

export interface CompletionSchema {
  name: string;
  tables: CompletionTable[];
}

export interface CompletionCatalog {
  database: string;
  schemas: CompletionSchema[];
}

export interface CompletionMetadataProvider {
  getCatalog(database: string): Promise<CompletionCatalog | null>;
  getColumns(database: string, schema: string | undefined, table: string): Promise<CompletionColumn[]>;
}

interface Token {
  kind: 'word' | 'dot' | 'punct';
  value: string;
  start: number;
  end: number;
}

interface PathMatch {
  parts: string[];
  start: number;
  end: number;
}

interface LocalRelation {
  name: string;
  alias?: string;
  database?: string;
  schema?: string;
  table?: string;
  kind: 'TABLE' | 'VIEW' | 'CTE' | 'TEMP';
  columns: CompletionColumn[];
}

const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'JOIN',
  'LEFT',
  'RIGHT',
  'FULL',
  'INNER',
  'OUTER',
  'CROSS',
  'ON',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS',
  'AS',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'ALL',
  'DISTINCT',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'TABLE',
  'TEMP',
  'TEMPORARY',
  'WITH',
  'DISTRIBUTE',
  'RANDOM',
  'HASH',
  'ORGANIZE',
  'EXTERNAL',
  'RECLAIM',
  'GROOM',
  'GENERATE',
  'STATISTICS',
  'NZPLSQL'
];

const RESERVED_ALIAS_WORDS = new Set([
  'as',
  'on',
  'where',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'join',
  'left',
  'right',
  'full',
  'inner',
  'outer',
  'cross',
  'union',
  'when',
  'then',
  'else',
  'end',
  'using'
]);

function isIdentifierStart(char: string | undefined): boolean {
  return !!char && /[A-Za-z_$#]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$#]/.test(char);
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(sql.length, i + 2);
      continue;
    }
    if (char === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (char === '"') {
      const start = i++;
      let value = '';
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        value += sql[i++];
      }
      tokens.push({ kind: 'word', value, start, end: i });
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = i++;
      while (isIdentifierPart(sql[i])) i++;
      tokens.push({ kind: 'word', value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (char === '.') {
      tokens.push({ kind: 'dot', value: '.', start: i, end: i + 1 });
      i++;
      continue;
    }
    if ('(),;*+-/%=<>&|'.includes(char)) {
      tokens.push({ kind: 'punct', value: char, start: i, end: i + 1 });
    }
    i++;
  }
  return tokens;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function normalized(value: string): string {
  return value.toUpperCase();
}

function findPathAtCursor(sql: string, offset: number): PathMatch | null {
  const boundedOffset = Math.max(0, Math.min(offset, sql.length));
  const tokens = tokenize(sql.slice(0, boundedOffset));
  const last = tokens[tokens.length - 1];
  if (!last || last.end !== boundedOffset || (last.kind !== 'word' && last.kind !== 'dot')) return null;

  let start = last.start;
  let index = tokens.length - 1;
  while (index > 0) {
    const previous = tokens[index - 1];
    const current = tokens[index];
    if (previous.end !== current.start || (previous.kind !== 'word' && previous.kind !== 'dot')) break;
    start = previous.start;
    index--;
  }

  const text = sql.slice(start, boundedOffset);
  if (!/^(?:[A-Za-z_$#][A-Za-z0-9_$#]*|"(?:[^"]|"")*"|\.)+$/.test(text)) return null;
  return {
    parts: text.split('.').map((part) => part.replace(/^"|"$/g, '').replace(/""/g, '')),
    start,
    end: boundedOffset
  };
}

function collectPath(tokens: Token[], startIndex: number): { parts: string[]; nextIndex: number } | null {
  if (tokens[startIndex]?.kind !== 'word') return null;
  const parts = [tokens[startIndex].value];
  let index = startIndex + 1;
  while (tokens[index]?.kind === 'dot' && tokens[index + 1]?.kind === 'word') {
    parts.push(tokens[index + 1].value);
    index += 2;
  }
  return { parts, nextIndex: index };
}

function findClosingParenthesis(tokens: Token[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokens[i].value === '(') depth++;
    if (tokens[i].value === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.value === '(') depth++;
    if (token.value === ')') depth--;
    if (token.value === ',' && depth === 0) {
      if (current.length > 0) parts.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function projectionName(tokens: Token[]): string | null {
  if (tokens.length === 0) return null;
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (lower(tokens[i].value) === 'as' && tokens[i + 1]?.kind === 'word') return tokens[i + 1].value;
  }
  const last = tokens[tokens.length - 1];
  if (last.kind !== 'word' || ['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'case'].includes(lower(last.value))) return null;
  return last.value;
}

function extractSelectColumns(sql: string): CompletionColumn[] {
  const tokens = tokenize(sql);
  const selectIndex = tokens.findIndex((token) => lower(token.value) === 'select');
  if (selectIndex < 0) return [];
  let depth = 0;
  let fromIndex = tokens.length;
  for (let i = selectIndex + 1; i < tokens.length; i++) {
    if (tokens[i].value === '(') depth++;
    if (tokens[i].value === ')') depth--;
    if (depth === 0 && ['from', 'union', 'where', 'group', 'order', 'limit'].includes(lower(tokens[i].value))) {
      fromIndex = i;
      break;
    }
  }
  const result: CompletionColumn[] = [];
  for (const expression of splitTopLevel(tokens.slice(selectIndex + 1, fromIndex))) {
    const name = projectionName(expression);
    if (name && name !== '*') result.push({ name, type: 'derived' });
  }
  return result;
}

function parseCtes(sql: string, offset: number): LocalRelation[] {
  const tokens = tokenize(sql);
  const result: LocalRelation[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (lower(tokens[i].value) !== 'with' || tokens[i].start >= offset) continue;
    let index = i + 1;
    if (lower(tokens[index]?.value ?? '') === 'recursive') index++;
    while (tokens[index]?.kind === 'word') {
      const name = tokens[index].value;
      index++;
      let declaredColumns: string[] = [];
      if (tokens[index]?.value === '(') {
        const close = findClosingParenthesis(tokens, index);
        if (close < 0) break;
        declaredColumns = splitTopLevel(tokens.slice(index + 1, close))
          .map((part) => part[0]?.value)
          .filter((value): value is string => !!value);
        index = close + 1;
      }
      if (lower(tokens[index]?.value ?? '') !== 'as' || tokens[index + 1]?.value !== '(') break;
      const open = index + 1;
      const close = findClosingParenthesis(tokens, open);
      if (close < 0) break;
      const body = sql.slice(tokens[open].end, tokens[close].start);
      const columns = declaredColumns.length > 0 ? declaredColumns.map((name) => ({ name, type: 'derived' })) : extractSelectColumns(body);
      if (offset >= tokens[open].start) {
        result.push({ name, kind: 'CTE', columns, table: name });
      }
      index = close + 1;
      if (tokens[index]?.value !== ',') break;
      index++;
    }
  }
  return result;
}

function parseTempTables(sql: string, offset: number): LocalRelation[] {
  const tokens = tokenize(sql);
  const result: LocalRelation[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (lower(tokens[i].value) !== 'create' || tokens[i].start >= offset) continue;
    let index = i + 1;
    if (['global', 'local', 'volatile'].includes(lower(tokens[index]?.value ?? ''))) index++;
    if (!['temp', 'temporary'].includes(lower(tokens[index]?.value ?? ''))) continue;
    index++;
    if (lower(tokens[index]?.value ?? '') !== 'table') continue;
    index++;
    if (lower(tokens[index]?.value ?? '') === 'if' && lower(tokens[index + 1]?.value ?? '') === 'not' && lower(tokens[index + 2]?.value ?? '') === 'exists') index += 3;
    const path = collectPath(tokens, index);
    if (!path) continue;
    index = path.nextIndex;
    let columns: CompletionColumn[] = [];
    if (tokens[index]?.value === '(') {
      const close = findClosingParenthesis(tokens, index);
      if (close >= 0) {
        columns = splitTopLevel(tokens.slice(index + 1, close))
          .filter((part) => part[0] && !['primary', 'unique', 'constraint', 'distribute', 'organize'].includes(lower(part[0].value)))
          .map((part) => ({ name: part[0].value, type: part[1]?.value ?? 'derived' }));
      }
    } else if (lower(tokens[index]?.value ?? '') === 'as') {
      columns = extractSelectColumns(sql.slice(tokens[index].end));
    }
    const table = path.parts[path.parts.length - 1];
    if (offset >= tokens[i].start) result.push({ name: table, table, schema: path.parts.length > 1 ? path.parts[path.parts.length - 2] : undefined, kind: 'TEMP', columns });
  }
  return result;
}

function resolvePath(parts: string[], activeDatabase: string): { database?: string; schema?: string; table: string } | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return { database: activeDatabase, table: parts[0] };
  if (parts.length === 2) return { database: activeDatabase, schema: parts[0], table: parts[1] };
  if (parts.length === 3 && parts[1] === '') return { database: parts[0], table: parts[2] };
  if (parts.length >= 3) return { database: parts[0], schema: parts[1] || undefined, table: parts[2] };
  return null;
}

function parseRelations(sql: string, offset: number, activeDatabase: string, local: LocalRelation[]): LocalRelation[] {
  const tokens = tokenize(sql.slice(0, offset));
  const result: LocalRelation[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const keyword = lower(tokens[i].value);
    if (!['from', 'join', 'update', 'into'].includes(keyword)) continue;
    const path = collectPath(tokens, i + 1);
    if (!path) continue;
    const resolved = resolvePath(path.parts, activeDatabase);
    if (!resolved) continue;
    const localName = normalized(path.parts[path.parts.length - 1]);
    const localRelation = local.find((item) => normalized(item.name) === localName);
    let nextIndex = path.nextIndex;
    let alias: string | undefined;
    if (lower(tokens[nextIndex]?.value ?? '') === 'as') nextIndex++;
    if (tokens[nextIndex]?.kind === 'word' && !RESERVED_ALIAS_WORDS.has(lower(tokens[nextIndex].value))) alias = tokens[nextIndex].value;
    result.push({
      name: resolved.table,
      alias,
      database: resolved.database,
      schema: resolved.schema,
      table: resolved.table,
      kind: localRelation?.kind ?? 'TABLE',
      columns: localRelation?.columns ?? []
    });
    if (alias) result.push({ ...result[result.length - 1], name: alias });
  }
  return result;
}

function sourceContext(sql: string, start: number): boolean {
  const tokens = tokenize(sql.slice(0, start));
  const last = tokens[tokens.length - 1];
  return !!last && last.kind === 'word' && ['from', 'join', 'update', 'into'].includes(lower(last.value));
}

function item(label: string, kind: CompletionKind, detail?: string, insertText = label): CompletionItem {
  return { label, insertText, detail, kind };
}

function dedupe(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  return items.filter((candidate) => {
    const key = `${candidate.kind}:${normalized(candidate.label)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 500);
}

function localColumnItems(relations: LocalRelation[], qualifier?: string, partial = ''): CompletionItem[] {
  const upperQualifier = qualifier ? normalized(qualifier) : undefined;
  const columns = relations
    .filter((relation) => !upperQualifier || normalized(relation.name) === upperQualifier || normalized(relation.alias ?? '') === upperQualifier)
    .flatMap((relation) => relation.columns.map((column) => item(column.name, 'column', `${relation.kind} · ${column.type}`)))
    .filter((candidate) => normalized(candidate.label).startsWith(normalized(partial)));
  return dedupe(columns);
}

function catalogTables(catalog: CompletionCatalog, schema: string | undefined, partial: string): CompletionItem[] {
  return dedupe(catalog.schemas
    .filter((entry) => !schema || normalized(entry.name) === normalized(schema))
    .flatMap((entry) => entry.tables
      .filter((table) => normalized(table.name).startsWith(normalized(partial)))
      .map((table) => item(table.name, table.kind === 'VIEW' ? 'view' : 'table', `${entry.name} · ${table.kind}`))));
}

function catalogSchemas(catalog: CompletionCatalog, partial: string): CompletionItem[] {
  return dedupe(catalog.schemas
    .filter((schema) => normalized(schema.name).startsWith(normalized(partial)))
    .map((schema) => item(schema.name, 'schema', catalog.database)));
}

function findCatalogTable(catalog: CompletionCatalog, schema: string | undefined, table: string): CompletionTable | undefined {
  return catalog.schemas
    .filter((entry) => !schema || normalized(entry.name) === normalized(schema))
    .flatMap((entry) => entry.tables)
    .find((candidate) => normalized(candidate.name) === normalized(table));
}

async function safeCatalog(provider: CompletionMetadataProvider, database: string): Promise<CompletionCatalog | null> {
  try {
    return await provider.getCatalog(database);
  } catch {
    return null;
  }
}

async function safeColumns(provider: CompletionMetadataProvider, database: string, schema: string | undefined, table: string): Promise<CompletionColumn[]> {
  try {
    return await provider.getColumns(database, schema, table);
  } catch {
    return [];
  }
}

async function columnItemsForPath(
  parts: string[],
  activeDatabase: string,
  relations: LocalRelation[],
  provider: CompletionMetadataProvider,
  partial: string
): Promise<CompletionItem[]> {
  const qualifierParts = parts.slice(0, -1);
  const qualifier = qualifierParts.join('.');
  const localItems = localColumnItems(relations, qualifier, partial);
  if (localItems.length > 0) return localItems;

  const qualifiedRelations = relations.filter((relation) => {
    const upper = normalized(qualifier);
    return upper === normalized(relation.name) || upper === normalized(relation.alias ?? '');
  });
  if (qualifiedRelations.length > 0) {
    const loaded = (await Promise.all(qualifiedRelations
      .filter((relation) => relation.table)
      .map(async (relation) => safeColumns(provider, relation.database ?? activeDatabase, relation.schema, relation.table!))))
      .flat();
    if (loaded.length > 0) {
      return dedupe(loaded
        .filter((column) => normalized(column.name).startsWith(normalized(partial)))
        .map((column) => item(column.name, 'column', `${qualifiedRelations[0].name} · ${column.type}`)));
    }
  }

  const resolved = resolvePath(qualifierParts, activeDatabase);
  if (!resolved || !resolved.table) return [];
  const columns = await safeColumns(provider, resolved.database ?? activeDatabase, resolved.schema, resolved.table);
  return dedupe(columns
    .filter((column) => normalized(column.name).startsWith(normalized(partial)))
    .map((column) => item(column.name, 'column', `${resolved.schema ? `${resolved.schema}.` : ''}${resolved.table} · ${column.type}`)));
}

async function objectItemsForPath(
  parts: string[],
  activeDatabase: string,
  provider: CompletionMetadataProvider,
  activeCatalog: CompletionCatalog | null
): Promise<CompletionItem[]> {
  const partial = parts[parts.length - 1] ?? '';
  if (parts.length === 1) {
    return activeCatalog ? catalogTables(activeCatalog, undefined, partial) : [];
  }

  if (parts.length === 2) {
    const first = parts[0];
    if (normalized(first) === normalized(activeDatabase)) {
      return activeCatalog ? catalogSchemas(activeCatalog, partial) : [];
    }
    if (activeCatalog?.schemas.some((schema) => normalized(schema.name) === normalized(first))) {
      return activeCatalogTables(activeCatalog, first, partial);
    }
    const explicitCatalog = await safeCatalog(provider, first);
    if (explicitCatalog) return catalogSchemas(explicitCatalog, partial);
    return activeCatalog ? catalogTables(activeCatalog, first, partial) : [];
  }

  if (parts[1] === '') {
    const catalog = normalized(parts[0]) === normalized(activeDatabase) ? activeCatalog : await safeCatalog(provider, parts[0]);
    return catalog ? catalogTables(catalog, undefined, partial) : [];
  }

  const catalog = normalized(parts[0]) === normalized(activeDatabase) ? activeCatalog : await safeCatalog(provider, parts[0]);
  return catalog ? catalogTables(catalog, parts[1], partial) : [];
}

function activeCatalogTables(catalog: CompletionCatalog, schema: string, partial: string): CompletionItem[] {
  return catalogTables(catalog, schema, partial);
}

export async function completeSql(
  sql: string,
  offset: number,
  activeDatabase: string,
  provider: CompletionMetadataProvider
): Promise<{ items: CompletionItem[] }> {
  const boundedOffset = Math.max(0, Math.min(offset, sql.length));
  const path = findPathAtCursor(sql, boundedOffset);
  const activeCatalog = await safeCatalog(provider, activeDatabase);
  const local = [...parseCtes(sql, boundedOffset), ...parseTempTables(sql, boundedOffset)];
  // The cursor is commonly in `SELECT alias.` while FROM/JOIN appears later
  // on the same statement. Parse the whole text for relations, while CTE/temp
  // definitions still remain limited to what is known before the cursor.
  const relations = parseRelations(sql, sql.length, activeDatabase, local);
  const availableRelations = [...relations, ...local];
  const keywords = SQL_KEYWORDS.map((keyword) => item(keyword, 'keyword'));

  if (!path) {
    if (sourceContext(sql, boundedOffset)) {
      const objects = await objectItemsForPath([''], activeDatabase, provider, activeCatalog);
      const localObjects = local
        .map((relation) => item(relation.name, relation.kind === 'CTE' ? 'cte' : 'temp-table', `${relation.kind} · ${relation.columns.length} columns`));
      return { items: dedupe([...localObjects, ...objects, ...keywords]) };
    }
    return { items: dedupe([...localColumnItems(availableRelations), ...keywords]) };
  }

  const partial = path.parts[path.parts.length - 1] ?? '';
  const trailingDot = partial === '' && path.parts.length > 1;
  if (path.parts.length > 1) {
    const columnItems = await columnItemsForPath(path.parts, activeDatabase, availableRelations, provider, partial);
    if (columnItems.length > 0 || !sourceContext(sql, path.start)) {
      return { items: dedupe([...columnItems, ...keywords]) };
    }
  }

  const objectItems = await objectItemsForPath(path.parts, activeDatabase, provider, activeCatalog);
  if (objectItems.length > 0 || sourceContext(sql, path.start) || trailingDot) {
    const localItems = local
      .filter((relation) => normalized(relation.name).startsWith(normalized(partial)))
      .map((relation) => item(relation.name, relation.kind === 'CTE' ? 'cte' : 'temp-table', `${relation.kind} · ${relation.columns.length} columns`));
    return { items: dedupe([...localItems, ...objectItems, ...keywords]) };
  }

  return { items: dedupe([...localColumnItems(availableRelations, undefined, partial), ...keywords]) };
}

export const completionTestUtils = {
  findPathAtCursor,
  extractSelectColumns,
  parseCtes,
  parseTempTables
};
