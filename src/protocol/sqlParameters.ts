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

    let result = '';
    let i = 0;
    let dollarQuote: string | null = null;

    while (i < sql.length) {
        if (dollarQuote) {
            if (sql.startsWith(dollarQuote, i)) {
                result += dollarQuote;
                i += dollarQuote.length;
                dollarQuote = null;
            } else {
                result += sql[i++];
            }
            continue;
        }

        const ch = sql[i];

        // SQL line comments do not contain parameters. Preserve the complete
        // comment, including its line terminator, byte-for-byte.
        if (ch === '-' && sql[i + 1] === '-') {
            const lineEnd = sql.indexOf('\n', i + 2);
            if (lineEnd === -1) {
                result += sql.slice(i);
                break;
            }
            result += sql.slice(i, lineEnd + 1);
            i = lineEnd + 1;
            continue;
        }

        // SQL block comments may contain arbitrary '$1'-like text.
        if (ch === '/' && sql[i + 1] === '*') {
            const commentEnd = sql.indexOf('*/', i + 2);
            if (commentEnd === -1) {
                result += sql.slice(i);
                break;
            }
            result += sql.slice(i, commentEnd + 2);
            i = commentEnd + 2;
            continue;
        }

        if (ch === "'") {
            const start = i++;
            while (i < sql.length) {
                if (sql[i] === '\\' && i + 1 < sql.length) {
                    i += 2;
                    continue;
                }
                if (sql[i] !== "'") {
                    i++;
                    continue;
                }
                if (sql[i + 1] === "'") {
                    i += 2;
                    continue;
                }
                i++;
                break;
            }
            result += sql.slice(start, i);
            continue;
        }

        if (ch === '"') {
            const start = i++;
            while (i < sql.length) {
                if (sql[i] === '"' && sql[i + 1] === '"') {
                    i += 2;
                    continue;
                }
                if (sql[i] === '"') {
                    i++;
                    break;
                }
                i++;
            }
            result += sql.slice(start, i);
            continue;
        }

        // Preserve PostgreSQL/Netezza dollar-quoted bodies, including bodies
        // used by procedural SQL. A numeric suffix is a parameter, not a tag.
        if (ch === '$') {
            const tagMatch = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
            if (tagMatch) {
                dollarQuote = tagMatch[0];
                result += dollarQuote;
                i += dollarQuote.length;
                continue;
            }

            const parameterMatch = sql.slice(i).match(/^\$(\d+)/);
            if (parameterMatch) {
                const match = parameterMatch[0];
                const idx = parseInt(parameterMatch[1], 10) - 1;
                result += idx >= 0 && idx < params.length ? escapeLiteral(params[idx]) : match;
                i += match.length;
                continue;
            }
        }

        result += ch;
        i++;
    }

    return result;
}
