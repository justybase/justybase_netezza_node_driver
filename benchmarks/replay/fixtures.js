const { loadFixture, loadWireFixture } = require('../../tests/helpers/replay/NzReplayFixture');

const TEXT_ROWS = 50000;

/**
 * Text-protocol workload: the Rust `text_types` capture (INT4, NVARCHAR,
 * NUMERIC(10,4), DATE, TIMESTAMP, BOOL, FLOAT8, TIME as DataRow 'D') with its
 * single row repeated, since no large text-protocol capture exists.
 */
function textFixture(rows) {
    const wire = loadWireFixture('text_types');
    const response = wire.responses[0];
    const frames = [];
    let offset = 0;
    while (offset < response.length && response[offset] !== 0x5a) {
        const end = offset + 9 + response.readInt32BE(offset + 5);
        frames.push({ type: String.fromCharCode(response[offset]), bytes: response.subarray(offset, end) });
        offset = end;
    }
    const parts = [];
    for (const frame of frames) {
        if (frame.type === 'D') for (let i = 0; i < rows; i++) parts.push(frame.bytes);
        else parts.push(frame.bytes);
    }
    parts.push(response.subarray(offset));
    return { query: wire.statements[0], handshake: wire.handshake, responses: [Buffer.concat(parts)] };
}

/** Fixture by benchmark name: C# `.nzreplay.gz` captures plus the synthetic `text50k`. */
function loadBenchFixture(name) {
    return name === 'text50k' ? textFixture(TEXT_ROWS) : loadFixture(name);
}

module.exports = { loadBenchFixture };
