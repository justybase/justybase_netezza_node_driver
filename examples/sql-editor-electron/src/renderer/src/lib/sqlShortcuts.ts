export const SQL_SHORTCUTS: Readonly<Record<string, string>> = {
  SX: 'SELECT',
  WX: 'WHERE',
  FX: 'FROM',
  GX: 'GROUP BY',
  HX: 'HAVING'
};

function isBoundary(value: string | undefined): boolean {
  return value === undefined || !/[A-Za-z0-9_$]/.test(value);
}

function isCodePosition(sql: string, offset: number): boolean {
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < offset; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) index++;
        else quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      lineComment = true;
      index++;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      index++;
    } else if (char === "'" || char === '"') {
      quote = char;
    }
  }
  return !lineComment && !blockComment && !quote;
}

export function findSqlShortcut(sql: string, cursorOffset: number): { start: number; end: number; replacement: string } | null {
  if (cursorOffset < 1 || sql[cursorOffset - 1] !== ' ' || !isCodePosition(sql, cursorOffset - 1)) return null;
  for (const [shortcut, replacement] of Object.entries(SQL_SHORTCUTS)) {
    const start = cursorOffset - 1 - shortcut.length;
    if (start < 0 || sql.slice(start, cursorOffset - 1).toUpperCase() !== shortcut) continue;
    if (!isBoundary(sql[start - 1])) continue;
    return { start, end: cursorOffset, replacement: `${replacement} ` };
  }
  return null;
}

export function expandSqlShortcut(sql: string, cursorOffset: number): { value: string; cursorOffset: number } | null {
  const match = findSqlShortcut(sql, cursorOffset);
  if (!match) return null;
  return {
    value: `${sql.slice(0, match.start)}${match.replacement}${sql.slice(match.end)}`,
    cursorOffset: match.start + match.replacement.length
  };
}
