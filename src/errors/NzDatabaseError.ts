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
    /** All backend diagnostic fields keyed by their protocol field code. */
    readonly diagnostics: Readonly<Record<string, string>>;
    /** Raw payload as received from the backend */
    readonly raw: string;

    constructor(fields: {
        severity?: string;
        code?: string;
        message: string;
        detail?: string;
        hint?: string;
        diagnostics?: Readonly<Record<string, string>>;
        raw: string;
    }) {
        const message = fields.message || fields.raw || 'Netezza backend returned an empty error response';
        super(message);
        this.name = 'NzDatabaseError';
        this.severity = fields.severity;
        this.code = fields.code;
        this.dbMessage = message;
        this.detail = fields.detail;
        this.hint = fields.hint;
        this.diagnostics = Object.freeze({ ...(fields.diagnostics ?? {}) });
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
    diagnostics: Readonly<Record<string, string>>;
    raw: string;
} {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const raw = buf.toString('utf8').replace(/\0+$/g, '');

    let nonLocalizedSeverity: string | undefined;
    let localizedSeverity: string | undefined;
    let code: string | undefined;
    let message = '';
    let detail: string | undefined;
    let hint: string | undefined;
    const diagnostics: Record<string, string> = {};

    // A structured body has a NUL after each field and one final terminator,
    // while legacy text has at most the single terminator at its end. This
    // prevents text such as "ERROR: ..." or "Password ..." from becoming
    // synthetic diagnostic fields (E/P) while retaining unknown fields in a
    // real structured response.
    let nulCount = 0;
    for (const byte of buf) {
        if (byte === 0) nulCount++;
    }

    if (nulCount >= 2) {
        let i = 0;
        while (i < buf.length) {
            const type = buf[i++];
            if (type === 0) break;

            let end = i;
            while (end < buf.length && buf[end] !== 0) end++;
            const value = buf.subarray(i, end).toString('utf8');
            i = end < buf.length ? end + 1 : end;

            const field = String.fromCharCode(type);
            diagnostics[field] = value;

            switch (field) {
                case 'S':
                    localizedSeverity = value;
                    break;
                case 'V':
                    nonLocalizedSeverity = value;
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
    }

    // V is the non-localized severity and is the most stable value for
    // applications. Keep S and V separately in diagnostics in either case.
    const severity = nonLocalizedSeverity ?? localizedSeverity;

    if (!message) {
        // Fallback: treat entire payload as message (legacy / non-field payloads)
        message = raw.replace(/\0/g, '').trim() || 'Netezza backend returned an empty error response';
    }

    return { severity, code, message, detail, hint, diagnostics: Object.freeze(diagnostics), raw };
}

export function createNzDatabaseError(data: Buffer | string): NzDatabaseError {
    return new NzDatabaseError(parseBackendErrorFields(data));
}
