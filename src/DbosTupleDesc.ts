/**
 * Tuple descriptor for binary row format
 * Port of C# DbosTupleDesc.cs
 */

import { NzProtocolError, validateProtocolLength } from './protocol/ProtocolLength';

interface CachedRowDescription {
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
    fieldNullByteOffset: number[] = [];
    fieldNullBitMask: number[] = [];
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
        this.fieldNullByteOffset = [];
        this.fieldNullBitMask = [];
        this.fieldFixedSize = [];
        this.fieldSpringField = [];
    }

    /**
     * Parse tuple description from binary data
     * @param data - raw data from backend
     * @param cachedRowDescription - optional cached textual column metadata
     */
    parse(data: Buffer, cachedRowDescription?: CachedRowDescription): void {
        this.clear();

        if (data.length < 36) {
            throw new NzProtocolError(
                'Invalid RowDescriptionStandard payload: descriptor header is truncated; reconnect is required.'
            );
        }

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

        if (this.numFields < 0 || this.numFields > 100_000) {
            throw new NzProtocolError(
                `Invalid RowDescriptionStandard payload: field count ${this.numFields} is out of range; ` +
                    'reconnect is required.'
            );
        }

        const descriptorLength = 36 + this.numFields * 36 + 8;
        validateProtocolLength(descriptorLength, 'rowDescriptionStandardDescriptor');
        if (data.length < descriptorLength) {
            throw new NzProtocolError(
                `Invalid RowDescriptionStandard payload: expected at least ${descriptorLength} bytes, received ${data.length}; ` +
                    'reconnect is required.'
            );
        }

        const NzTypeInt = 3;
        const NzTypeIntvsAbsTimeFIX = 39;

        for (let ix = 0; ix < this.numFields; ix++) {
            let ft = data.readInt32BE(idx);

            // Fix for abstime type (OID 702) being returned as int
            // https://github.com/IBM/nzpy/issues/61
            if (ft === NzTypeInt && cachedRowDescription?.description?.[ix]?.typeOid === 702) {
                ft = NzTypeIntvsAbsTimeFIX;
            }

            this.fieldType.push(ft);
            this.fieldSize.push(data.readInt32BE(idx + 4));
            this.fieldTrueSize.push(data.readInt32BE(idx + 8));
            this.fieldOffset.push(data.readInt32BE(idx + 12));
            const physField = data.readInt32BE(idx + 16);
            this.fieldPhysField.push(physField);
            this.fieldLogField.push(data.readInt32BE(idx + 20));
            this.fieldNullAllowed.push(data.readInt32BE(idx + 24) !== 0);
            this.fieldNullByteOffset.push(2 + Math.floor(physField / 8));
            this.fieldNullBitMask.push(1 << (physField % 8));
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
