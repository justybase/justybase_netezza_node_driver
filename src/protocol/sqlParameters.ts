/**
 * Client-side SQL parameter substitution for Netezza.
 *
 * IMPORTANT: Netezza's simple-query path used by this driver does not expose
 * server-side bind/prepared parameters. Values are escaped and interpolated
 * into the SQL text before send. Prefer typed primitives; unknown object
 * shapes are rejected rather than stringified unsafely.
 */

export function escapeLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return value ? "'t'" : "'f'";
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError(`Cannot bind non-finite number: ${value}`);
        }
        return String(value);
    }
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`;
    }
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            throw new TypeError('Cannot bind invalid Date');
        }
        // Keep historical formatting (UTC wall time without timezone suffix)
        return `'${value
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d{3}Z$/, '')}'`;
    }
    if (Buffer.isBuffer(value)) {
        return `E'\\\\x${value.toString('hex')}'`;
    }
    throw new TypeError(
        `Unsupported parameter type: ${Object.prototype.toString.call(value)}. ` +
            'Pass null, boolean, number, bigint, string, Date, or Buffer.'
    );
}

/**
 * Replace $1, $2, ... placeholders with escaped literals.
 * Unmatched placeholders are left unchanged.
 */
export function substituteParameters(sql: string, params: unknown[]): string {
    if (!params || params.length === 0) return sql;
    return sql.replace(/\$(\d+)/g, (match, indexStr: string) => {
        const idx = parseInt(indexStr, 10) - 1;
        if (idx < 0 || idx >= params.length) return match;
        return escapeLiteral(params[idx]);
    });
}
