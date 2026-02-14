/**
 * Tuple descriptor for binary row format
 * Port of C# DbosTupleDesc.cs
 */

interface PreparedStatement {
    description?: Array<{ typeOid: number }>;
}

class DbosTupleDesc {
    version: number | null = null;
    nullsAllowed: number | null = null;
    sizeWord: number | null = null;
    sizeWordSize: number | null = null;
    numFixedFields: number | null = null;
    numVaryingFields: number | null = null;
    fixedFieldsSize: number = 0;
    maxRecordSize: number | null = null;
    numFields: number = 0;

    // Per-field arrays
    fieldType: number[] = [];
    fieldSize: number[] = [];
    fieldTrueSize: number[] = [];
    fieldOffset: number[] = [];
    fieldPhysField: number[] = [];
    fieldLogField: number[] = [];
    fieldNullAllowed: boolean[] = [];
    fieldFixedSize: number[] = [];
    fieldSpringField: number[] = [];

    // Date/time settings
    dateStyle: number | null = null;
    euroDates: number | null = null;

    /**
     * Reset all arrays for reuse
     */
    clear(): void {
        this.fieldType = [];
        this.fieldSize = [];
        this.fieldTrueSize = [];
        this.fieldOffset = [];
        this.fieldPhysField = [];
        this.fieldLogField = [];
        this.fieldNullAllowed = [];
        this.fieldFixedSize = [];
        this.fieldSpringField = [];
    }

    /**
     * Parse tuple description from binary data
     * @param data - raw data from backend
     * @param preparedStatement - prepared statement with description
     */
    parse(data: Buffer, preparedStatement?: PreparedStatement): void {
        this.clear();

        let idx = 0;
        this.version = data.readInt32BE(idx);
        idx += 4;
        this.nullsAllowed = data.readInt32BE(idx);
        idx += 4;
        this.sizeWord = data.readInt32BE(idx);
        idx += 4;
        this.sizeWordSize = data.readInt32BE(idx);
        idx += 4;
        this.numFixedFields = data.readInt32BE(idx);
        idx += 4;
        this.numVaryingFields = data.readInt32BE(idx);
        idx += 4;
        this.fixedFieldsSize = data.readInt32BE(idx);
        idx += 4;
        this.maxRecordSize = data.readInt32BE(idx);
        idx += 4;
        this.numFields = data.readInt32BE(idx);
        idx += 4;

        const NzTypeInt = 3;
        const NzTypeIntvsAbsTimeFIX = 39;

        for (let ix = 0; ix < this.numFields; ix++) {
            let ft = data.readInt32BE(idx);

            // Fix for abstime type (OID 702) being returned as int
            // https://github.com/IBM/nzpy/issues/61
            if (ft === NzTypeInt && preparedStatement?.description?.[ix]?.typeOid === 702) {
                ft = NzTypeIntvsAbsTimeFIX;
            }

            this.fieldType.push(ft);
            this.fieldSize.push(data.readInt32BE(idx + 4));
            this.fieldTrueSize.push(data.readInt32BE(idx + 8));
            this.fieldOffset.push(data.readInt32BE(idx + 12));
            this.fieldPhysField.push(data.readInt32BE(idx + 16));
            this.fieldLogField.push(data.readInt32BE(idx + 20));
            this.fieldNullAllowed.push(data.readInt32BE(idx + 24) !== 0);
            this.fieldFixedSize.push(data.readInt32BE(idx + 28));
            this.fieldSpringField.push(data.readInt32BE(idx + 32));
            idx += 36;
        }

        this.dateStyle = data.readInt32BE(idx);
        idx += 4;
        this.euroDates = data.readInt32BE(idx);
    }

    /**
     * Get field precision for numeric types
     * @param coldex - column index
     */
    getFieldPrecision(coldex: number): number {
        return (this.fieldSize[coldex] >> 8) & 0x7f;
    }

    /**
     * Get field scale for numeric types
     * @param coldex - column index
     */
    getFieldScale(coldex: number): number {
        return this.fieldSize[coldex] & 0x00ff;
    }

    /**
     * Get numeric digit count (32-bit parts)
     * @param coldex - column index
     */
    getNumericDigitCount(coldex: number): number {
        return Math.floor(this.fieldTrueSize[coldex] / 4);
    }
}

export { DbosTupleDesc };
