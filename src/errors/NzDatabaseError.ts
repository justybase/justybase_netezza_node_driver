/**
 * Structured database error thrown by the Netezza driver.
 * Fields follow PostgreSQL-style ErrorResponse encoding when present.
 */
export class NzDatabaseError extends Error {
    /** Severity (e.g. ERROR, FATAL, PANIC) when provided by the backend */
    readonly severity: string | undefined;
    /** SQLSTATE / error code when provided by the backend */
    readonly code: string | undefined;
    /** Primary human-readable message */
    readonly dbMessage: string;
    /** Optional detail */
    readonly detail: string | undefined;
    /** Optional hint */
    readonly hint: string | undefined;
    /** Raw payload as received from the backend */
    readonly raw: string;

    constructor(fields: {
        severity?: string;
        code?: string;
        message: string;
        detail?: string;
        hint?: string;
        raw: string;
    }) {
        super(fields.message || fields.raw || 'Netezza error');
        this.name = 'NzDatabaseError';
        this.severity = fields.severity;
        this.code = fields.code;
        this.dbMessage = fields.message;
        this.detail = fields.detail;
        this.hint = fields.hint;
        this.raw = fields.raw;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Parse a PostgreSQL/Netezza ErrorResponse or NoticeResponse body.
 * Body is a sequence of: typeByte + null-terminated C string, ending with a final NUL.
 */
export function parseBackendErrorFields(data: Buffer | string): {
    severity?: string;
    code?: string;
    message: string;
    detail?: string;
    hint?: string;
    raw: string;
} {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const raw = buf.toString('utf8').replace(/\0+$/g, '');

    let severity: string | undefined;
    let code: string | undefined;
    let message = '';
    let detail: string | undefined;
    let hint: string | undefined;

    let i = 0;
    while (i < buf.length) {
        const type = buf[i++];
        if (type === 0) break;

        let end = i;
        while (end < buf.length && buf[end] !== 0) end++;
        const value = buf.subarray(i, end).toString('utf8');
        i = end < buf.length ? end + 1 : end;

        switch (String.fromCharCode(type)) {
            case 'S':
            case 'V':
                severity = value;
                break;
            case 'C':
                code = value;
                break;
            case 'M':
                message = value;
                break;
            case 'D':
                detail = value;
                break;
            case 'H':
                hint = value;
                break;
            default:
                break;
        }
    }

    if (!message) {
        // Fallback: treat entire payload as message (legacy / non-field payloads)
        message = raw.replace(/\0/g, '').trim() || 'Unknown Netezza error';
    }

    return { severity, code, message, detail, hint, raw };
}

export function createNzDatabaseError(data: Buffer | string): NzDatabaseError {
    return new NzDatabaseError(parseBackendErrorFields(data));
}
