import type { NzCommand } from './NzCommand';
import type { TimeValue } from './types/TypeConversions';
import { NzDatabaseError } from './errors/NzDatabaseError';

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

interface ColumnMetadata {
    index: number;
    name: string;
    providerType: number;
    typeModifier: number;
    typeLength: number;
    typeName: string;
    declaredTypeName: string;
    declaredLength: number | null;
    numericPrecision: number;
    numericScale: number;
    dataType: (...args: unknown[]) => unknown;
    columnSize: number;
    isLong: boolean;
}

/**
 * Generator item from response
 */
interface GeneratorItem {
    type: string;
    row?: unknown[];
    columns?: ColumnDescription[];
    desc?: { fieldNullAllowed: boolean[] };
    message?: string;
    error?: NzDatabaseError;
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
    Oid: 26,
    AbsTime: 702,
    ByteInt: 2500,
    NChar: 2522,
    NVarChar: 2530,
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
    private _pendingNullability: boolean[] | null = null;
    private _isFinished: boolean = false;
    private _resultComplete: boolean = false;
    private _nextItem: GeneratorItem | null;
    private _hasRows: boolean;
    private _columnNullability: boolean[] | null;
    private _columnMetadataCache: Array<ColumnMetadata | null> = [];
    private _columnNames: string[] = [];

    constructor(
        command: NzCommand,
        generator: AsyncGenerator<GeneratorItem>,
        columns: ColumnDescription[] | null,
        columnNullability: boolean[] | null,
        releaseCallback: (() => void) | null,
        initialNextItem: GeneratorItem | null
    ) {
        this.command = command;
        this.generator = generator;
        this.columnDescriptions = [];
        this._columnNullability = null;
        this.releaseCallback = releaseCallback;

        this._setColumnState(columns, columnNullability);
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
        this._pendingNullability = null;
        if (this.releaseCallback) {
            this.releaseCallback();
            this.releaseCallback = null;
        }
    }

    private _cloneNullability(nullability: boolean[] | null | undefined): boolean[] | null {
        if (!nullability || nullability.length === 0) {
            return null;
        }
        return [...nullability];
    }

    private _setColumnState(columns: ColumnDescription[] | null, nullability: boolean[] | null): void {
        this.columnDescriptions = columns || [];
        this._columnNullability = this._cloneNullability(nullability);
        this._columnMetadataCache = new Array(this.columnDescriptions.length).fill(null);
        this._columnNames = this.columnDescriptions.map((column) => column.name);
        this._initNameIndex();
    }

    private _getColumnAllowsNull(i: number): boolean {
        if (!this._columnNullability || i >= this._columnNullability.length) {
            return true;
        }
        return this._columnNullability[i];
    }

    private _getColumnDescription(i: number): ColumnDescription {
        if (i < 0 || i >= this.columnDescriptions.length) {
            throw new Error(`Column ordinal ${i} is out of range`);
        }
        return this.columnDescriptions[i];
    }

    private _isCharacterType(oid: number): boolean {
        switch (oid) {
            case 15:
            case Oid.Char:
            case Oid.Name:
            case Oid.Text:
            case Oid.BpChar:
            case Oid.VarChar:
            case Oid.NChar:
            case Oid.NVarChar:
                return true;
            default:
                return false;
        }
    }

    private _getTypeNameFromOid(oid: number): string {
        switch (oid) {
            case Oid.Bool:
                return 'BOOL';
            case Oid.Bytea:
                return 'BYTEA';
            case Oid.ByteInt:
                return 'BYTEINT';
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
            case Oid.Oid:
                return 'OID';
            case Oid.Text:
                return 'TEXT';
            case Oid.NChar:
                return 'NCHAR';
            case Oid.BpChar:
                return 'CHAR';
            case Oid.VarChar:
                return 'VARCHAR';
            case Oid.NVarChar:
                return 'NVARCHAR';
            case Oid.AbsTime:
                return 'ABSTIME';
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
            case 15:
                return 'CHAR';
            default:
                return `UNKNOWN(${oid})`;
        }
    }

    private _getNumericPrecisionScale(typeMod: number): { precision: number; scale: number } {
        if (typeMod > TYPE_MOD_OFFSET) {
            const normalized = typeMod - TYPE_MOD_OFFSET;
            return {
                precision: normalized >> 16,
                scale: normalized & 0xffff,
            };
        }
        return { precision: 0, scale: 0 };
    }

    private _getCharacterDeclaredLength(col: ColumnDescription): number | null {
        if (!this._isCharacterType(col.typeOid)) {
            return null;
        }
        if (col.typeMod > TYPE_MOD_OFFSET) {
            return col.typeMod - TYPE_MOD_OFFSET;
        }
        return null;
    }

    private _formatDeclaredTypeName(
        oid: number,
        typeName: string,
        declaredLength: number | null,
        numericPrecision: number,
        numericScale: number
    ): string {
        switch (oid) {
            case Oid.BpChar:
            case Oid.VarChar:
            case Oid.NChar:
            case Oid.NVarChar:
                return declaredLength !== null ? `${typeName}(${declaredLength})` : typeName;
            case Oid.Numeric:
                return numericPrecision > 0 ? `NUMERIC(${numericPrecision},${numericScale})` : typeName;
            default:
                return typeName;
        }
    }

    private _getResolvedColumnMetadata(col: ColumnDescription, index: number): ColumnMetadata {
        const oid = col.typeOid;
        const typeName = this._getTypeNameFromOid(oid);
        const declaredLength = this._getCharacterDeclaredLength(col);
        const numeric = this._getNumericPrecisionScale(col.typeMod);

        let columnSize: number;
        let numericPrecision = 0;
        let numericScale = 0;
        let dataType: (...args: unknown[]) => unknown;

        switch (oid) {
            case Oid.Bool:
                dataType = Boolean;
                columnSize = 1;
                break;
            case Oid.ByteInt:
                dataType = Number;
                columnSize = 1;
                break;
            case Oid.Int2:
                dataType = Number;
                columnSize = 2;
                break;
            case Oid.Int4:
                dataType = Number;
                columnSize = 4;
                break;
            case Oid.Int8:
                dataType = BigInt as unknown as (...args: unknown[]) => unknown;
                columnSize = 8;
                break;
            case Oid.Oid:
                dataType = Number;
                columnSize = col.typeLen > 0 ? col.typeLen : 4;
                break;
            case Oid.Float4:
            case Oid.Float8:
                dataType = Number;
                columnSize = oid === Oid.Float8 ? 8 : 4;
                numericPrecision = oid === Oid.Float8 ? 53 : 24;
                break;
            case Oid.Numeric:
                dataType = Number;
                numericPrecision = numeric.precision;
                numericScale = numeric.scale;
                if (numericPrecision > 0) {
                    columnSize = Math.floor(numericPrecision / 2) + 1;
                    if (columnSize < col.typeLen && col.typeLen > 0) {
                        columnSize = col.typeLen;
                    }
                } else {
                    columnSize = col.typeLen > 0 ? col.typeLen : -1;
                }
                break;
            case Oid.Date:
            case Oid.AbsTime:
            case Oid.Timestamp:
            case Oid.TimestampTz:
            case Oid.Time:
            case Oid.TimeTz:
                dataType = oid === Oid.Time || oid === Oid.TimeTz ? Object : Date;
                columnSize = col.typeLen > 0 ? col.typeLen : oid === Oid.AbsTime ? 4 : -1;
                break;
            case 15:
            case Oid.Char:
            case Oid.BpChar:
            case Oid.VarChar:
            case Oid.Text:
            case Oid.Name:
            case Oid.NChar:
            case Oid.NVarChar:
                dataType = String;
                columnSize = declaredLength ?? (col.typeLen > 0 ? col.typeLen : -1);
                break;
            default:
                dataType = String;
                columnSize = col.typeLen > 0 ? col.typeLen : -1;
                break;
        }

        return {
            index,
            name: col.name,
            providerType: oid,
            typeModifier: col.typeMod,
            typeLength: col.typeLen,
            typeName,
            declaredTypeName: this._formatDeclaredTypeName(
                oid,
                typeName,
                declaredLength,
                numericPrecision,
                numericScale
            ),
            declaredLength,
            numericPrecision,
            numericScale,
            dataType,
            columnSize,
            isLong: columnSize > 8000,
        };
    }

    async nextResult(): Promise<boolean> {
        if (this.closed || this._isFinished) return false;

        let foundNextResult = false;
        if (this._pendingColumns) {
            this._setColumnState(this._pendingColumns, this._pendingNullability);
            this._pendingColumns = null;
            this._pendingNullability = null;
            this.currentRow = null;
            this._resultComplete = false;
            foundNextResult = true;
        }

        // nextResult() may be called before the caller has consumed the current
        // result. Drain it only as far as CommandComplete, then look for the next
        // RowDescription. Once read() has already observed CommandComplete there
        // is nothing left to drain from the current result.
        let drainingCurrentResult = !foundNextResult && !this._resultComplete;
        this.currentRow = null;

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
                this._setColumnState(val.columns!, null);
                this.currentRow = null;
                drainingCurrentResult = false;
                foundNextResult = true;
                this._resultComplete = false;
                continue;
            }

            if (val.type === 'RowDescriptionStandard') {
                const ps = this.command._cachedRowDescription;
                if (this.columnDescriptions.length === 0 && ps && ps.description) {
                    this._setColumnState(ps.description, val.desc?.fieldNullAllowed ?? null);
                } else {
                    this._columnNullability = this._cloneNullability(val.desc?.fieldNullAllowed ?? null);
                }
                this.currentRow = null;
                if (!drainingCurrentResult) {
                    foundNextResult = true;
                    this._resultComplete = false;
                }
                continue;
            }

            if (val.type === 'DataRow') {
                if (drainingCurrentResult || !foundNextResult) {
                    continue;
                }
                this._nextItem = val;
                this._hasRows = true;
                return true;
            }

            if (val.type === 'CommandComplete') {
                if (drainingCurrentResult) {
                    drainingCurrentResult = false;
                    this._resultComplete = true;
                    continue;
                }
                if (foundNextResult) {
                    this._resultComplete = true;
                    this._hasRows = false;
                    return true;
                }
                // Non-row-returning statements do not form a data reader result
                // set. Continue until a RowDescription or ReadyForQuery arrives.
                continue;
            }

            if (val.type === 'NoticeResponse') {
                this.command._notices.push(val.message || '');
                continue;
            }

            if (val.type === 'ErrorResponse') {
                throw val.error instanceof NzDatabaseError
                    ? val.error
                    : new NzDatabaseError({ message: val.message || 'Unknown Netezza Error', raw: val.message || '' });
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
            const metadata = this.getColumnMetadata(i);
            const row: SchemaRow = {
                ColumnName: metadata.name,
                ColumnOrdinal: i + 1,
                ColumnSize: metadata.columnSize,
                NumericPrecision: metadata.numericPrecision,
                NumericScale: metadata.numericScale,
                DataType: metadata.dataType,
                ProviderType: metadata.providerType,
                AllowDBNull: this._getColumnAllowsNull(i),
                IsReadOnly: true,
                IsLong: metadata.isLong,
            };
            table.push(row);
        }
        return { Rows: table, Columns: { Count: table.length } };
    }

    getTypeName(i: number): string {
        return this.getColumnMetadata(i).typeName;
    }

    getDeclaredTypeName(i: number): string {
        return this.getColumnMetadata(i).declaredTypeName;
    }

    getProviderType(i: number): number {
        return this.getColumnMetadata(i).providerType;
    }

    getTypeModifier(i: number): number {
        return this.getColumnMetadata(i).typeModifier;
    }

    getTypeLength(i: number): number {
        return this.getColumnMetadata(i).typeLength;
    }

    getColumnMetadata(i: number): ColumnMetadata {
        const cached = this._columnMetadataCache[i];
        if (cached) {
            return cached;
        }

        const metadata = this._getResolvedColumnMetadata(this._getColumnDescription(i), i);
        this._columnMetadataCache[i] = metadata;
        return metadata;
    }

    async read(): Promise<boolean> {
        if (this.closed || this._isFinished) return false;
        if (this._resultComplete) return false;
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
                this._pendingNullability = null;
                this.currentRow = null;
                return false;
            }

            if (val.type === 'RowDescriptionStandard') {
                const ps = this.command._cachedRowDescription;
                this._pendingColumns = ps && ps.description ? ps.description : this.columnDescriptions;
                this._pendingNullability = this._cloneNullability(val.desc?.fieldNullAllowed ?? null);
                this.currentRow = null;
                return false;
            }

            if (val.type === 'CommandComplete') {
                this.currentRow = null;
                this._resultComplete = true;
                return false;
            }

            if (val.type === 'NoticeResponse') {
                this.command._notices.push(val.message || '');
                continue;
            }

            if (val.type === 'ErrorResponse') {
                throw val.error instanceof NzDatabaseError
                    ? val.error
                    : new NzDatabaseError({ message: val.message || 'Unknown Netezza Error', raw: val.message || '' });
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
        for (let i = 0; i < this._columnNames.length; i++) {
            obj[this._columnNames[i]] = this.currentRow[i];
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
                        if (val.type === 'NoticeResponse') {
                            this.command._notices.push(val.message || '');
                        }
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

    async [Symbol.asyncDispose](): Promise<void> {
        return this.close();
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
        try {
            while (await this.read()) {
                yield this.getRowObject()!;
            }
        } finally {
            await this.close();
        }
    }
}

export { NzDataReader, ColumnDescription, ColumnMetadata, GeneratorItem };
