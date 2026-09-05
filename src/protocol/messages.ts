import type { DbosTupleDesc } from '../DbosTupleDesc';
import type { NzDatabaseError } from '../errors/NzDatabaseError';

export interface ColumnInfo {
    name: string;
    typeOid: number;
    typeLen: number;
    typeMod: number;
    format: number;
}

export type ResponseMessage =
    | { type: 'ErrorResponse'; message: string; error: NzDatabaseError }
    | { type: 'RowDescription'; columns: ColumnInfo[] }
    | { type: 'RowDescriptionStandard'; desc: DbosTupleDesc }
    | { type: 'DataRow'; row: unknown[] }
    | { type: 'CommandComplete'; text: string; rowsAffected: number }
    | { type: 'NoticeResponse'; message: string }
    | { type: 'ReadyForQuery' };
