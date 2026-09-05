/**
 * Compile-time tests for the generic query and streaming reader API.
 *
 * These files are never executed — the TypeScript compiler is the test runner.
 * Run them with `npm run typecheck:types` (also run in CI, see
 * `.github/workflows/ci.yml`).
 *
 * How to read the assertions:
 * - `Expect<Equal<A, B>>` fails the build unless `A` and `B` are exactly equal.
 * - Every `@ts-expect-error` line must actually produce an error. If a typing
 *   regresses (rows degrade to `any`, a type argument stops being honored,
 *   defaults stop defaulting), the line stops erroring and the build fails.
 */
import type { NzConnection, NzPool, NzDataReader, QueryResult, QueryResultRow } from '../../src/index';

interface TableRow {
    TABLENAME: string;
    NROWS: number;
}

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const conn: NzConnection;
declare const pool: NzPool;

// ---------------------------------------------------------------------------
// Buffered query<T>()
// ---------------------------------------------------------------------------

async function bufferedQueryTyped(): Promise<void> {
    const result = await conn.query<TableRow>('SELECT TABLENAME, NROWS FROM _V_TABLE');

    type _rowsAreTableRowArray = Expect<Equal<typeof result.rows, TableRow[]>>;
    const resultIsTyped: QueryResult<TableRow> = result;

    const name: string = result.rows[0].TABLENAME;
    const nrows: number = result.rows[0].NROWS;

    // @ts-expect-error - NROWS_MISSING is not a column of TableRow
    const missing: string = result.rows[0].NROWS_MISSING;

    void resultIsTyped;
    void name;
    void nrows;
    void missing;
}

async function poolQueryTyped(): Promise<void> {
    const result = await pool.query<{ ID: number }>('SELECT 1');

    type _rowsAreIdArray = Expect<Equal<typeof result.rows, { ID: number }[]>>;

    const id: number = result.rows[0].ID;

    // @ts-expect-error - ID_MISSING is not part of the row shape
    const missing: string = result.rows[0].ID_MISSING;

    void id;
    void missing;
}

async function defaultsStayStrict(): Promise<void> {
    const result = await conn.query('SELECT 1');

    type _rowsAreQueryResultRowArray = Expect<Equal<typeof result.rows, QueryResultRow[]>>;

    // @ts-expect-error - values stay unknown without an explicit row type
    const bad: string = result.rows[0].anything;
    const val: unknown = result.rows[0].anything;

    void bad;
    void val;
}

// ---------------------------------------------------------------------------
// executeReader<T>() — typed reader
// ---------------------------------------------------------------------------

async function executeReaderTyped(): Promise<void> {
    const cmd = conn.createCommand('SELECT TABLENAME, NROWS FROM _V_TABLE');

    const reader = await conn.executeReader<TableRow>(cmd);
    const typedRef: NzDataReader<TableRow> = reader;

    // getRowObject() uses TRow.
    const row: TableRow | null = reader.getRowObject();

    // currentRow / getValues() are typed through TRow (array of its value types).
    const current: (string | number)[] | null = reader.currentRow;
    const values: (string | number)[] = reader.getValues();

    // @ts-expect-error - currentRow is nullable, so it is not a plain (string | number)[]
    const badCurrent: (string | number)[] = reader.currentRow;

    // @ts-expect-error - getValues() elements are string | number, not boolean
    const badElement: boolean = reader.getValues()[0];

    // Async iteration yields TRow.
    for await (const typedRow of reader) {
        const tname: string = typedRow.TABLENAME;
        // @ts-expect-error - not a column of TableRow
        const tmissing: string = typedRow.NROWS_MISSING;
        void tname;
        void tmissing;
    }

    // Typed reader through the command as well.
    const cmdReader = await cmd.executeReader<TableRow>();
    const row2: TableRow | null = cmdReader.getRowObject();

    void typedRef;
    void row;
    void current;
    void values;
    void badCurrent;
    void badElement;
    void row2;
}

// ---------------------------------------------------------------------------
// Default (untyped) readers keep the strict unknown contract; overrides work
// ---------------------------------------------------------------------------

async function readerDefaultsAndOverrides(): Promise<void> {
    const reader = await conn.executeReader(conn.createCommand('SELECT 1'));

    const row: QueryResultRow | null = reader.getRowObject();

    const unk: unknown = reader.currentRow?.[0];

    // @ts-expect-error - getValues() elements stay unknown on a default reader
    const bad: string = reader.getValues()[0];

    // Per-call overrides still work without a typed reader.
    const shaped = reader.getRowObject<TableRow>();
    const name: string | null = shaped ? shaped.TABLENAME : null;
    const values = reader.getValues<[number, string]>();
    const first: number = values[0];
    const second: string = values[1];

    void row;
    void bad;
    void unk;
    void name;
    void first;
    void second;
}

void bufferedQueryTyped;
void poolQueryTyped;
void defaultsStayStrict;
void executeReaderTyped;
void readerDefaultsAndOverrides;
