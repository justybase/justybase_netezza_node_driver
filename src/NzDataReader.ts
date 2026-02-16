import type { NzCommand } from './NzCommand';

/**
 * Column description from the database
 */
interface ColumnDescription {
    name: string;
    typeOid: number;
    typeMod: number;
    typeLen: number;
}

/**
 * Schema table row information
 */
interface SchemaRow {
    ColumnName: string;
    ColumnOrdinal: number;
    ColumnSize: number;
    NumericPrecision: number;
    NumericScale: number;
    DataType: (...args: unknown[]) => unknown;
    ProviderType: number;
    AllowDBNull: boolean;
    IsReadOnly: boolean;
    IsLong: boolean;
}

/**
 * Generator item from response
 */
interface GeneratorItem {
    type: string;
    row?: unknown[];
    columns?: ColumnDescription[];
    message?: string;
}

/**
 * Time value structure
 */
interface TimeValue {
    hours: number;
    minutes: number;
    seconds: number;
    microseconds: number;
    toString(): string;
}

// Postgres/Netezza OIDs
const Oid = {
    Bool: 16,
    Bytea: 17,
    Char: 18,
    Name: 19,
    Int8: 20,
    Int2: 21,
    Int4: 23,
    Text: 25,
    ShowDate: 2530,
    BpChar: 1042,
    VarChar: 1043,
    Date: 1082,
    Time: 1083,
    Timestamp: 1114,
    TimestampTz: 1184,
    Interval: 1186,
    TimeTz: 1266,
    Numeric: 1700,
    Float4: 700,
    Float8: 701,
} as const;

const TYPE_MOD_OFFSET = 16;

/**
 * Data reader for query results
 * Port of C# NzDataReader.cs
 */
class NzDataReader {
    command: NzCommand;
    generator: AsyncGenerator<GeneratorItem>;
    columnDescriptions: ColumnDescription[];
    releaseCallback: (() => void) | null;
    currentRow: unknown[] | null = null;
    closed: boolean = false;

    private _nameIndex: Record<string, number> = {};
    private _pendingColumns: ColumnDescription[] | null = null;
    private _isFinished: boolean = false;
    private _nextItem: GeneratorItem | null;
    private _hasRows: boolean;

    constructor(
        command: NzCommand,
        generator: AsyncGenerator<GeneratorItem>,
        columns: ColumnDescription[] | null,
        releaseCallback: (() => void) | null,
        initialNextItem: GeneratorItem | null
    ) {
        this.command = command;
        this.generator = generator;
        this.columnDescriptions = columns || [];
        this.releaseCallback = releaseCallback;

        this._initNameIndex();
        this._nextItem = initialNextItem;
        this._hasRows = !!(this._nextItem && this._nextItem.type === 'DataRow');
    }

    get hasRows(): boolean {
        return this._hasRows;
    }

    private _initNameIndex(): void {
        this._nameIndex = {};
        if (this.columnDescriptions) {
            for (let i = 0; i < this.columnDescriptions.length; i++) {
                this._nameIndex[this.columnDescriptions[i].name.toLowerCase()] = i;
            }
        }
    }

    private _markFinished(): void {
        this._isFinished = true;
        this._nextItem = null;
        this._hasRows = false;
        if (this.releaseCallback) {
            this.releaseCallback();
            this.releaseCallback = null;
        }
    }

    async nextResult(): Promise<boolean> {
        if (this._pendingColumns) {
            this.columnDescriptions = this._pendingColumns;
            this._pendingColumns = null;
            this._initNameIndex();
            this.currentRow = null;

            while (true) {
                const nextRes = await this.generator.next();
                if (nextRes.done) {
                    this._nextItem = null;
                    this._hasRows = false;
                    break;
                }
                const val = nextRes.value;
                if (val.type === 'RowDescriptionStandard') {
                    continue;
                } else if (val.type === 'DataRow') {
                    this._nextItem = val;
                    this._hasRows = true;
                    break;
                } else if (val.type === 'CommandComplete') {
                    this._nextItem = val;
                    this._hasRows = false;
                    break;
                } else {
                    this._nextItem = val;
                    this._hasRows = false;
                    break;
                }
            }

            return true;
        }

        if (this.closed || this._isFinished) return false;

        while (true) {
            let res: IteratorResult<GeneratorItem>;
            if (this._nextItem) {
                res = { value: this._nextItem, done: false };
                this._nextItem = null;
            } else {
                res = await this.generator.next();
            }

            if (res.done) {
                this._markFinished();
                return false;
            }
            const val = res.value;

            if (val.type === 'RowDescription') {
                this.columnDescriptions = val.columns!;
                this._initNameIndex();
                this.currentRow = null;
                continue;
            }

            if (val.type === 'RowDescriptionStandard') {
                const ps = this.command._preparedStatement;
                if (this.columnDescriptions.length === 0 && ps && ps.description) {
                    this.columnDescriptions = ps.description;
                    this._initNameIndex();
                }
                this.currentRow = null;
                continue;
            }

            if (val.type === 'DataRow') {
                this._nextItem = val;
                this._hasRows = true;
                return true;
            }

            if (val.type === 'CommandComplete') {
                continue;
            }

            if (val.type === 'ErrorResponse') {
                throw new Error(val.message || 'Unknown Netezza Error');
            }

            if (val.type === 'ReadyForQuery') {
                this._markFinished();
                return false;
            }
        }
    }

    getSchemaTable(): { Rows: SchemaRow[]; Columns: { Count: number } } | SchemaRow[] {
        if (!this.columnDescriptions) return [];

        const table: SchemaRow[] = [];
        for (let i = 0; i < this.columnDescriptions.length; i++) {
            const col = this.columnDescriptions[i];
            const row: SchemaRow = {
                ColumnName: col.name,
                ColumnOrdinal: i + 1,
                ColumnSize: -1,
                NumericPrecision: 0,
                NumericScale: 0,
                DataType: String,
                ProviderType: col.typeOid,
                AllowDBNull: true,
                IsReadOnly: true,
                IsLong: false,
            };

            const mod = col.typeMod;
            const oid = col.typeOid;

            switch (oid) {
                case Oid.Bool:
                    row.DataType = Boolean;
                    row.ColumnSize = 1;
                    break;
                case Oid.Int2:
                    row.DataType = Number;
                    row.ColumnSize = 2;
                    break;
                case Oid.Int4:
                    row.DataType = Number;
                    row.ColumnSize = 4;
                    break;
                case Oid.Int8:
                    row.DataType = Number;
                    row.ColumnSize = 8;
                    break;
                case Oid.Float4:
                case Oid.Float8:
                    row.DataType = Number;
                    row.ColumnSize = oid === Oid.Float8 ? 8 : 4;
                    row.NumericPrecision = oid === Oid.Float8 ? 53 : 24;
                    break;
                case Oid.Numeric:
                    row.DataType = Number;
                    if (mod > TYPE_MOD_OFFSET) {
                        const p = (mod - TYPE_MOD_OFFSET) >> 16;
                        const s = (mod - TYPE_MOD_OFFSET) & 0xffff;
                        row.NumericPrecision = p;
                        row.NumericScale = s;
                        row.ColumnSize = Math.floor(p / 2) + 1;
                        if (row.ColumnSize < col.typeLen && col.typeLen > 0) row.ColumnSize = col.typeLen;
                    } else {
                        row.ColumnSize = col.typeLen;
                    }
                    break;
                case Oid.Date:
                case Oid.Timestamp:
                case Oid.TimestampTz:
                case Oid.Time:
                case Oid.TimeTz:
                    row.DataType = Date;
                    if (oid === Oid.Time || oid === Oid.TimeTz) {
                        row.DataType = Object;
                    }
                    row.ColumnSize = col.typeLen;
                    break;
                case Oid.Char:
                case Oid.BpChar:
                case Oid.VarChar:
                case Oid.Text:
                case Oid.Name:
                case Oid.ShowDate:
                    row.DataType = String;
                    if (mod > TYPE_MOD_OFFSET) {
                        row.ColumnSize = mod - TYPE_MOD_OFFSET;
                    } else {
                        row.ColumnSize = -1;
                        if (col.typeLen > 0) row.ColumnSize = col.typeLen;
                    }
                    if (row.ColumnSize > 8000) row.IsLong = true;
                    break;
                default:
                    row.DataType = String;
                    row.ColumnSize = col.typeLen;
                    break;
            }
            table.push(row);
        }
        return { Rows: table, Columns: { Count: table.length } };
    }

    getTypeName(i: number): string {
        if (i < 0 || i >= this.columnDescriptions.length) {
            throw new Error(`Column ordinal ${i} is out of range`);
        }
        const col = this.columnDescriptions[i];
        const oid = col.typeOid;

        switch (oid) {
            case Oid.Bool:
                return 'BOOL';
            case Oid.Bytea:
                return 'BYTEA';
            case Oid.Char:
                return 'CHAR';
            case Oid.Name:
                return 'NAME';
            case Oid.Int8:
                return 'INT8';
            case Oid.Int2:
                return 'INT2';
            case Oid.Int4:
                return 'INT4';
            case Oid.Text:
                return 'TEXT';
            case Oid.BpChar:
                return 'CHAR';
            case Oid.VarChar:
                return 'VARCHAR';
            case Oid.Date:
                return 'DATE';
            case Oid.Time:
                return 'TIME';
            case Oid.Timestamp:
                return 'TIMESTAMP';
            case Oid.TimestampTz:
                return 'TIMESTAMPTZ';
            case Oid.Interval:
                return 'INTERVAL';
            case Oid.TimeTz:
                return 'TIMETZ';
            case Oid.Numeric:
                return 'NUMERIC';
            case Oid.Float4:
                return 'FLOAT4';
            case Oid.Float8:
                return 'FLOAT8';
            case 2530:
                return 'DATE';
            case 15:
                return 'CHAR';
            case 16:
                return 'BOOL';
            default:
                return `UNKNOWN(${oid})`;
        }
    }

    async read(): Promise<boolean> {
        if (this.closed || this._isFinished) return false;
        if (this._pendingColumns) return false;

        while (true) {
            let res: IteratorResult<GeneratorItem>;
            if (this._nextItem) {
                res = { value: this._nextItem, done: false };
                this._nextItem = null;
            } else {
                res = await this.generator.next();
            }

            if (res.done) {
                this._markFinished();
                this.currentRow = null;
                return false;
            }

            const val = res.value;
            if (val.type === 'DataRow') {
                this.currentRow = val.row!;
                return true;
            }

            if (val.type === 'RowDescription') {
                this._pendingColumns = val.columns!;
                this.currentRow = null;
                return false;
            }

            if (val.type === 'RowDescriptionStandard') {
                const ps = this.command._preparedStatement;
                this._pendingColumns = ps && ps.description ? ps.description : this.columnDescriptions;
                this.currentRow = null;
                return false;
            }

            if (val.type === 'CommandComplete') {
                this.currentRow = null;
                continue;
            }

            if (val.type === 'ErrorResponse') {
                throw new Error(val.message || 'Unknown Netezza Error');
            }

            if (val.type === 'ReadyForQuery') {
                this._markFinished();
                this.currentRow = null;
                return false;
            }

            continue;
        }
    }

    getValue(i: number): unknown {
        this._validateOrdinal(i);
        return this.currentRow![i];
    }

    getValueByName(name: string): unknown {
        const i = this.getOrdinal(name);
        return this.getValue(i);
    }

    getName(i: number): string {
        if (i < 0 || i >= this.columnDescriptions.length) {
            throw new Error(`Column ordinal ${i} is out of range`);
        }
        return this.columnDescriptions[i].name;
    }

    getOrdinal(name: string): number {
        const idx = this._nameIndex[name.toLowerCase()];
        if (idx === undefined) {
            throw new Error(`Column '${name}' not found`);
        }
        return idx;
    }

    get fieldCount(): number {
        return this.columnDescriptions?.length || 0;
    }

    get FieldCount(): number {
        return this.fieldCount;
    }

    isDBNull(i: number): boolean {
        this._validateOrdinal(i);
        return this.currentRow![i] === null;
    }

    getBoolean(i: number): boolean {
        const val = this.getValue(i);
        if (val === null) return false;
        if (typeof val === 'boolean') return val;
        if (typeof val === 'string') return val.toLowerCase() === 't' || val === '1' || val.toLowerCase() === 'true';
        return Boolean(val);
    }

    getByte(i: number): number {
        const val = this.getValue(i);
        return val === null ? 0 : Number(val) & 0xff;
    }

    getInt16(i: number): number {
        const val = this.getValue(i);
        return val === null ? 0 : Number(val);
    }

    getInt32(i: number): number {
        const val = this.getValue(i);
        return val === null ? 0 : Number(val);
    }

    getInt64(i: number): number | bigint {
        const val = this.getValue(i);
        if (val === null) return 0;
        if (typeof val === 'bigint') return val;
        return Number(val);
    }

    getFloat(i: number): number {
        const val = this.getValue(i);
        return val === null ? 0.0 : Number(val);
    }

    getDouble(i: number): number {
        const val = this.getValue(i);
        return val === null ? 0.0 : Number(val);
    }

    getDecimal(i: number): number | string {
        const val = this.getValue(i);
        if (val === null) return 0;
        if (typeof val === 'string') return val;
        return Number(val);
    }

    getString(i: number): string | null {
        const val = this.getValue(i);
        if (val === null) return null;
        if (typeof val === 'string') return val;
        if (val && val.toString) return val.toString();
        return String(val);
    }

    getDateTime(i: number): Date | null {
        const val = this.getValue(i);
        if (val === null) return null;
        if (val instanceof Date) return val;
        return new Date(val as string | number);
    }

    getTimeSpan(i: number): TimeValue | unknown | null {
        const val = this.getValue(i);
        if (val === null) return null;
        if (typeof val === 'object' && 'hours' in val) return val;
        if (typeof val === 'string') {
            const parts = val.split(':');
            if (parts.length >= 2) {
                const secParts = (parts[2] || '0').split('.');
                return {
                    hours: parseInt(parts[0], 10),
                    minutes: parseInt(parts[1], 10),
                    seconds: parseInt(secParts[0], 10),
                    microseconds: secParts.length > 1 ? parseInt(secParts[1].padEnd(6, '0'), 10) : 0,
                    toString(): string {
                        return val;
                    },
                };
            }
        }
        return val;
    }

    getRowObject(): Record<string, unknown> | null {
        if (!this.currentRow) return null;
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < this.columnDescriptions.length; i++) {
            obj[this.columnDescriptions[i].name] = this.currentRow[i];
        }
        return obj;
    }

    getValues(): unknown[] {
        if (!this.currentRow) return [];
        return [...this.currentRow];
    }

    async close(): Promise<void> {
        if (!this.closed) {
            this.closed = true;
            if (!this._isFinished && this.generator) {
                try {
                    for await (const val of this.generator) {
                        if (val.type === 'ReadyForQuery') break;
                    }
                } catch {
                    // ignore
                }
            }
            if (this.releaseCallback) {
                this.releaseCallback();
                this.releaseCallback = null;
            }
        }
    }

    get isClosed(): boolean {
        return this.closed;
    }

    private _validateOrdinal(i: number): void {
        if (!this.currentRow) {
            throw new Error('No current row. Did you call read()?');
        }
        if (i < 0 || i >= this.columnDescriptions.length) {
            throw new Error(`Column ordinal ${i} is out of range`);
        }
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
        while (await this.read()) {
            yield this.getRowObject()!;
        }
    }
}

export { NzDataReader, ColumnDescription, GeneratorItem };
