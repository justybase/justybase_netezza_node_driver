/**
 * Loader for `.nzreplay.gz` fixtures recorded by the C# reference driver
 * (JustyBase.NetezzaDriver `tools/NzReplayCapture`).
 *
 * Layout (gzip around a .NET BinaryWriter stream, little-endian):
 *   u32 magic 0x4E5A5250, i32 version (2), string query (7-bit varint length +
 *   UTF-8), i32 expectedRows, i32 expectedColumns, i32 segmentCount, then
 *   segmentCount × (i32 length + bytes).
 *
 * Segments hold raw server→client bytes only: segment 0 is the handshake, each
 * later segment is the response to the n-th client query packet. The last
 * segment is the response to the recorded user query.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAGIC = 0x4e5a5250;
const VERSION = 2;

function readDotNetString(buf, offset) {
    let length = 0;
    let shift = 0;
    for (;;) {
        const b = buf[offset++];
        length |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 28) throw new Error('Invalid 7-bit encoded string length');
    }
    return { value: buf.toString('utf8', offset, offset + length), offset: offset + length };
}

function parseFixture(raw) {
    const buf = zlib.gunzipSync(raw);
    let offset = 0;
    if (buf.readUInt32LE(offset) !== MAGIC) throw new Error('Not an .nzreplay fixture (bad magic)');
    offset += 4;
    const version = buf.readInt32LE(offset);
    offset += 4;
    if (version !== VERSION) throw new Error(`Unsupported .nzreplay version ${version}`);
    const query = readDotNetString(buf, offset);
    offset = query.offset;
    const expectedRows = buf.readInt32LE(offset);
    const expectedColumns = buf.readInt32LE(offset + 4);
    const segmentCount = buf.readInt32LE(offset + 8);
    offset += 12;
    const segments = [];
    for (let i = 0; i < segmentCount; i++) {
        const len = buf.readInt32LE(offset);
        offset += 4;
        segments.push(buf.subarray(offset, offset + len));
        offset += len;
    }
    if (segments.length < 2) throw new Error('Fixture needs a handshake and at least one response segment');
    return {
        query: query.value,
        expectedRows,
        expectedColumns,
        handshake: segments[0],
        responses: [segments[segments.length - 1]],
        segments,
    };
}

function fixtureCandidates(name) {
    const file = `${name}.nzreplay.gz`;
    const dirs = [];
    if (process.env.NZ_REPLAY_FIXTURE_DIR) dirs.push(process.env.NZ_REPLAY_FIXTURE_DIR);
    dirs.push(path.join(__dirname, '..', '..', 'fixtures', 'replay'));
    dirs.push(
        path.join(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            'JustyBase.NetezzaDriver',
            'src',
            'JustyBase.NetezzaDriver.TestSupport',
            'Fixtures'
        )
    );
    return dirs.map((dir) => path.join(dir, file));
}

function findFixture(name) {
    return fixtureCandidates(name).find((candidate) => fs.existsSync(candidate)) || null;
}

function loadFixture(name) {
    const file = findFixture(name);
    if (!file) throw new Error(`Replay fixture '${name}' not found in: ${fixtureCandidates(name).join(', ')}`);
    return parseFixture(fs.readFileSync(file));
}

const WIRE_MAGIC = 'NZWIRE01';

/**
 * Loads a golden wire fixture recorded by the Rust driver
 * (`justybase_netezza_driver_rust/tests/fixtures/wire`): `"NZWIRE01"`, u32 LE
 * record count, then per record u32 LE SQL length + SQL and u32 LE response
 * length + response bytes. Only query-phase server bytes are stored, so the
 * handshake is borrowed from a `.nzreplay.gz` capture.
 */
function loadWireFixture(name) {
    const buf = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'wire', `${name}.bin`));
    if (buf.toString('latin1', 0, 8) !== WIRE_MAGIC) throw new Error(`${name}.bin: not an NZWIRE01 fixture`);
    const count = buf.readUInt32LE(8);
    let offset = 12;
    const statements = [];
    const responses = [];
    for (let i = 0; i < count; i++) {
        const sqlLength = buf.readUInt32LE(offset);
        statements.push(buf.toString('utf8', offset + 4, offset + 4 + sqlLength));
        offset += 4 + sqlLength;
        const responseLength = buf.readUInt32LE(offset);
        responses.push(buf.subarray(offset + 4, offset + 4 + responseLength));
        offset += 4 + responseLength;
    }
    return { handshake: loadFixture('dimdate').handshake, statements, responses };
}

module.exports = { loadFixture, loadWireFixture, findFixture, parseFixture };
