/**
 * Build a Netezza simple Query ('P') packet:
 *   'P' + int32 commandNumber + utf8 sql + NUL
 */
export function buildSimpleQueryPacket(sql: string, commandNumber: number): Buffer {
    const queryBytes = Buffer.from(sql, 'utf8');
    const buf = Buffer.allocUnsafe(1 + 4 + queryBytes.length + 1);
    buf[0] = 'P'.charCodeAt(0);
    buf.writeInt32BE(commandNumber, 1);
    queryBytes.copy(buf, 5);
    buf[5 + queryBytes.length] = 0;
    return buf;
}
