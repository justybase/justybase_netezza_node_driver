export function formatCell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', isNull: false };
  return { text: String(value), isNull: false };
}

export function typeShort(dataTypeID: number): string {
  switch (dataTypeID) {
    case 16:
      return 'BOOL';
    case 20:
      return 'INT8';
    case 21:
      return 'INT2';
    case 23:
      return 'INT4';
    case 26:
      return 'OID';
    case 700:
      return 'FLOAT4';
    case 701:
      return 'FLOAT8';
    case 1042:
      return 'CHAR';
    case 1043:
      return 'VARCHAR';
    case 1082:
      return 'DATE';
    case 1083:
      return 'TIME';
    case 1114:
      return 'TIMESTAMP';
    case 1184:
      return 'TIMESTAMPTZ';
    case 1700:
      return 'NUMERIC';
    case 2500:
      return 'BYTEINT';
    case 2522:
      return 'NCHAR';
    case 2530:
      return 'NVARCHAR';
    default:
      return dataTypeID ? `OID ${dataTypeID}` : '—';
  }
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export const SAMPLE_SQL = `-- Netezza SQL Editor · Ctrl/Cmd+Enter runs the selection or everything
-- This self-contained query is safe to try after connecting.
SELECT 1 AS driver_check, CURRENT_DATE AS today;
`;
