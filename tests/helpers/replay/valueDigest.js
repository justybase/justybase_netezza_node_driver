const crypto = require('crypto');

/** Stable, type-tagged text for one decoded value. */
function describeValue(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (value instanceof Date) return `date:${value.getTime()}`;
    if (Buffer.isBuffer(value)) return `buffer:${value.toString('hex')}`;
    switch (typeof value) {
        case 'number':
            return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
        case 'bigint':
            return `bigint:${value}`;
        case 'string':
            return `string:${value}`;
        case 'boolean':
            return `boolean:${value}`;
        case 'object':
            return `object:${JSON.stringify(value)}:${String(value)}`;
        default:
            return `${typeof value}:${String(value)}`;
    }
}

/** Incremental SHA-256 over every value of a result set, row by row. */
class ValueDigest {
    constructor() {
        this._hash = crypto.createHash('sha256');
        this.rows = 0;
    }

    addRow(values) {
        let line = '';
        for (let i = 0; i < values.length; i++) line += `${describeValue(values[i])}\u0001`;
        this._hash.update(line);
        this._hash.update('\n');
        this.rows++;
    }

    digest() {
        return this._hash.digest('hex');
    }
}

module.exports = { ValueDigest, describeValue };
