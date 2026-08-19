/**
 * Netezza client type identifiers sent in the connection handshake.
 *
 * The named values mirror the ClientTypeId enum used by the companion
 * JustyBase Netezza driver. Node.js uses the IBM-defined custom value 15.
 */
export const ClientTypeId = {
    Invalid: -1,
    None: 0,
    Sql: 1,
    SqlOdbc: 2,
    SqlJdbc: 3,
    Load: 4,
    Client: 5,
    Bnr: 6,
    Reclaim: 7,
    Unknown: 8,
    SqlOledb: 9,
    Internal: 10,
    SqlDotnet: 11,
    SqlGolang: 12,
    SqlPython: 13,
    Unknown2: 14,
    Node: 15,
} as const;

export type ClientTypeIdValue = (typeof ClientTypeId)[keyof typeof ClientTypeId];

/** Default client identity used by this Node.js driver. */
export const DEFAULT_CLIENT_TYPE = ClientTypeId.Node;

/**
 * Validate and resolve a client type before it is written as a signed 16-bit
 * handshake value. Unknown future server values remain possible, provided
 * they fit the wire representation.
 */
export function normalizeClientType(value: number | undefined): number {
    const clientType = value ?? DEFAULT_CLIENT_TYPE;

    if (!Number.isInteger(clientType) || clientType < -32768 || clientType > 32767) {
        throw new RangeError(`clientType must be an integer between -32768 and 32767; received ${String(clientType)}`);
    }

    return clientType;
}
