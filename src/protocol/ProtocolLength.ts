/**
 * Defensive limits for length-prefixed Netezza protocol fields.
 *
 * Lengths arrive from the server and are used for buffer allocation or cursor
 * movement. Keeping the validation in one place prevents malformed input from
 * turning into negative offsets, unbounded allocations, or a reusable socket
 * that is no longer aligned to message boundaries.
 */
export const MAX_PROTOCOL_PAYLOAD = 10_000_000;

/** Internal marker used to distinguish a protocol fault from a SQL error. */
export class NzProtocolError extends Error {
    readonly isProtocolError = true;

    constructor(message: string) {
        super(message);
        this.name = 'NzProtocolError';
    }
}

export function validateProtocolLength(
    length: number,
    field: string,
    options: { allowZero?: boolean; max?: number } = {}
): number {
    const allowZero = options.allowZero ?? true;
    const max = options.max ?? MAX_PROTOCOL_PAYLOAD;

    if (!Number.isInteger(length)) {
        throw new NzProtocolError(
            `Invalid backend protocol length for '${field}': ${String(length)}; integer required`
        );
    }
    if (length < 0) {
        throw new NzProtocolError(
            `Invalid backend protocol length for '${field}': ${length}; negative lengths are not valid. ` +
                'The connection is no longer safe to reuse; reconnect is required.'
        );
    }
    if (!allowZero && length === 0) {
        throw new NzProtocolError(
            `Invalid backend protocol length for '${field}': 0; zero is not valid for this field. ` +
                'The connection is no longer safe to reuse; reconnect is required.'
        );
    }
    if (length > max) {
        throw new NzProtocolError(
            `Invalid backend protocol length for '${field}': ${length}; maximum supported payload is ${max} bytes. ` +
                'The connection is no longer safe to reuse; reconnect is required.'
        );
    }

    return length;
}

export function validateProtocolLengthAfterOverhead(
    frameLength: number,
    overhead: number,
    frameField: string,
    payloadField: string,
    options: { payloadAllowZero?: boolean; max?: number } = {}
): number {
    if (!Number.isInteger(overhead) || overhead < 0) {
        throw new RangeError(`Protocol overhead must be a non-negative integer; received ${String(overhead)}`);
    }

    validateProtocolLength(frameLength, frameField, { allowZero: false, max: options.max });
    if (frameLength < overhead) {
        throw new NzProtocolError(
            `Invalid backend protocol length for '${payloadField}': ${frameLength - overhead}; ` +
                `frame is smaller than its ${overhead}-byte overhead. ` +
                'The connection is no longer safe to reuse; reconnect is required.'
        );
    }

    return validateProtocolLength(frameLength - overhead, payloadField, {
        allowZero: options.payloadAllowZero ?? true,
        max: options.max,
    });
}
