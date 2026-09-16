/**
 * Shared helper for C# reference compatibility tests.
 *
 * The C# runner (tools/csharp-reference, JustyBase.NetezzaDriver) is the live
 * compatibility reference for this driver. It supports:
 *   single query:  dotnet <dll> "<sql>"            -> { columns, types, rows }
 *   batch:         dotnet <dll> --batch (stdin)    -> [{ columns, types, rows, error }]
 *
 * Batch mode reuses one process and one DB connection for many queries, so the
 * full suite (~700 queries) stays in the minutes range instead of timing out.
 *
 * Comparison model: strict, with a closed list of representation equivalences
 * (see valuesEqual). Anything outside that list fails loudly with the exact
 * row/column position.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNNER_PROJECT = path.join(REPO_ROOT, 'tools', 'csharp-reference', 'CSharpReference.csproj');
const RUNNER_DLL = path.join(
    REPO_ROOT,
    'tools',
    'csharp-reference',
    'bin',
    'Release',
    'net10.0',
    'CSharpReference.dll'
);

/** Two connections read seconds apart; live timestamps may legitimately skew. */
const DATETIME_SKEW_ALLOWANCE_MS = 60000;
/** .NET decimal caps at 28-29 significant digits; Node preserves full precision. */
const DECIMAL_SIGNIFICANT_DIGITS = 28;

const NUMERIC_LIKE = /^[+-]?(\d+)(\.\d+)?$/;
const DATETIME_LIKE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

let buildAttempted = false;
let buildSucceeded = false;

function isDotnetAvailable() {
    try {
        return spawnSync('dotnet', ['--version'], { encoding: 'utf8' }).status === 0;
    } catch {
        return false;
    }
}

/**
 * Builds the C# runner once per Jest worker process. Throws on failure.
 */
function ensureBuilt() {
    if (buildAttempted) {
        if (!buildSucceeded) throw new Error('C# reference build previously failed.');
        return RUNNER_DLL;
    }
    buildAttempted = true;
    const result = spawnSync('dotnet', ['build', RUNNER_PROJECT, '-c', 'Release', '--nologo', '-v', 'q'], {
        encoding: 'utf8',
        timeout: 300000,
        env: process.env,
    });
    if (result.status !== 0) {
        throw new Error(`C# reference build failed: ${result.stderr || result.stdout}`);
    }
    buildSucceeded = true;
    return RUNNER_DLL;
}

/**
 * Runs many queries through one C# process/connection.
 * Returns [{ columns, types, rows, error }] in input order. Per-query SQL
 * errors are reported via `error` and do not throw; spawn-level failures do.
 */
function runBatch(queries, options = {}) {
    const dll = ensureBuilt();
    const timeout = options.timeoutMs || 600000;
    const result = spawnSync('dotnet', [dll, '--batch'], {
        input: JSON.stringify(queries),
        encoding: 'utf8',
        timeout,
        maxBuffer: 512 * 1024 * 1024,
        env: process.env,
    });
    if (result.error) {
        throw new Error(`C# reference batch spawn failed: ${result.error.message}`);
    }
    const stdout = (result.stdout || '').trim();
    if (!stdout) {
        throw new Error(`C# reference batch produced no output: ${result.stderr || '(empty stderr)'}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (e) {
        throw new Error(`C# reference batch returned invalid JSON: ${e.message}: ${stdout.slice(0, 500)}`);
    }
    if (!Array.isArray(parsed) || parsed.length !== queries.length) {
        throw new Error(`C# reference batch shape mismatch: got ${parsed.length}, expected ${queries.length}.`);
    }
    return parsed;
}

/**
 * Runs one query, throwing when the C# side reports a SQL error.
 */
function runSingle(query, options = {}) {
    const [res] = runBatch([query], options);
    if (res.error) {
        throw new Error(`C# reference failed for ${query}: ${res.error}`);
    }
    return { columns: res.columns, types: res.types || [], rows: res.rows };
}

function normalize(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return value ? 't' : 'f';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object' && value.hours !== undefined) {
        return `${String(value.hours).padStart(2, '0')}:${String(value.minutes).padStart(2, '0')}:${String(
            value.seconds
        ).padStart(2, '0')}`;
    }
    let text = String(value).trim();
    // TIME/TIMETZ print with zero-padded microseconds on one side and trimmed
    // fractions on the other ("14:13:12.432100+11:15" vs "14:13:12.4321+11:15").
    // Trim only time-like strings so NUMERIC scale ("123.450") stays exact.
    if (text.includes(':')) {
        text = text.replace(/(\.\d*?[1-9])0+(?=$|[+-]|Z)/, '$1').replace(/\.0+(?=$|[+-]|Z)/, '');
    }
    return text;
}

function normalizeReference(value) {
    if (value === null || value === undefined) return null;
    if (value.type === 'bytes') return value.value;
    if (value.type === 'Boolean') return value.value.toLowerCase() === 'true' ? 't' : 'f';
    if (value.type === 'datetime' || value.type === 'datetimeoffset') {
        const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value.value);
        return new Date(hasZone ? value.value : `${value.value}Z`).toISOString();
    }
    return normalize(value.value);
}

/** Maps a raw C# batch result to normalized row arrays. */
function toComparableRows(refResult) {
    return refResult.rows.map((row) => row.map(normalizeReference));
}

/**
 * Rounds a plain decimal string to `sig` significant digits (half up).
 * Returns the input unchanged when it is not a plain decimal.
 */
function roundToSignificantDigits(numStr, sig) {
    const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(numStr);
    if (!match) return numStr;
    const [, sign, intPart, fracPart = ''] = match;
    const digits = (intPart + fracPart).replace(/^0+/, '');
    if (digits === '') return '0';
    // Position of the decimal point within the digit stream (may be <= 0).
    let pointPos = intPart.replace(/^0+/, '').length;
    if (digits.length <= sig) return numStr;
    let kept = digits.slice(0, sig).split('').map(Number);
    if (digits[sig] >= '5') {
        let i = kept.length - 1;
        for (; i >= 0; i--) {
            kept[i] += 1;
            if (kept[i] < 10) break;
            kept[i] = 0;
        }
        if (i < 0) {
            kept = [1, ...kept];
            pointPos += 1;
        }
    }
    let out;
    if (pointPos >= kept.length) {
        out = kept.join('') + '0'.repeat(pointPos - kept.length);
    } else if (pointPos <= 0) {
        out = `0.${'0'.repeat(-pointPos)}${kept.join('')}`;
    } else {
        out = `${kept.slice(0, pointPos).join('')}.${kept.slice(pointPos).join('')}`;
    }
    if (out.includes('.')) {
        out = out.replace(/0+$/, '');
        if (out.endsWith('.')) out = out.slice(0, -1);
    }
    if (out === '' || out === '-0') return '0';
    return sign === '-' ? `-${out}` : out;
}

function bothNumericStrings(left, right) {
    return typeof left === 'string' && typeof right === 'string' && NUMERIC_LIKE.test(left) && NUMERIC_LIKE.test(right);
}

function bothDatetimeLike(left, right) {
    return (
        typeof left === 'string' &&
        typeof right === 'string' &&
        left.length > 10 &&
        right.length > 10 &&
        DATETIME_LIKE.test(left) &&
        DATETIME_LIKE.test(right)
    );
}

/**
 * Closed equivalence list for one compared cell. Returns a reason string when
 * the pair passes by equivalence, null when strictly equal, and throws when
 * the pair genuinely differs.
 */
function checkCell(left, right, refType) {
    if (left === right) return null;
    // Probed live: for NULL CHAR-ish catalog columns the C# driver reports ""
    // while the server null bitmap (honored by Node and ODBC) says NULL.
    // Neither side can adjudicate empty-vs-null against this reference.
    if ((left === null && right === '') || (left === '' && right === null)) {
        return 'empty-string vs null (C# reference quirk)';
    }
    if (bothNumericStrings(left, right)) {
        // .NET decimal holds 28 significant digits; longer NUMERIC values are
        // rounded server-side-identical but print-shorter on the C# side.
        if (
            roundToSignificantDigits(left, DECIMAL_SIGNIFICANT_DIGITS) ===
            roundToSignificantDigits(right, DECIMAL_SIGNIFICANT_DIGITS)
        ) {
            return 'equal at decimal28 precision';
        }
        // REAL is float32 on the wire. C# prints shortest round-trip ("3.14"),
        // Node prints the full float64 expansion ("3.140000104904175").
        // Same float32 bits <=> same value; scoped to Single columns only so
        // DOUBLE/NUMERIC strictness is unaffected.
        if (refType === 'Single') {
            const a = Number(left);
            const b = Number(right);
            const fa = Math.fround(a);
            const fb = Math.fround(b);
            if (Number.isFinite(fa) && Number.isFinite(fb) && fa === fb) {
                return 'same float32 value, different print';
            }
        }
    }
    // NOW()/CURRENT_* and live catalog timestamps are evaluated per read;
    // connections seconds apart legitimately skew. Day-or-larger shifts still fail.
    if (bothDatetimeLike(left, right)) {
        const skew = Math.abs(new Date(left).getTime() - new Date(right).getTime());
        if (skew <= DATETIME_SKEW_ALLOWANCE_MS) {
            return `datetime skew ${Math.round(skew)}ms within allowance`;
        }
    }
    return undefined;
}

/**
 * Strict assertion of a Node result against a raw C# batch result.
 * Throws an Error pinpointing the first differing row/column.
 */
function assertReferenceEqual(nodeResult, refResult, query) {
    if (refResult.error) {
        throw new Error(`C# reference failed for ${query}: ${refResult.error}`);
    }
    const refRows = toComparableRows(refResult);
    const refTypes = Array.isArray(refResult.types) ? refResult.types : [];
    if (nodeResult.columns.length !== refResult.columns.length) {
        throw new Error(
            `Column count differs for ${query}: Node ${nodeResult.columns.length} vs C# ${refResult.columns.length}.`
        );
    }
    for (let c = 0; c < nodeResult.columns.length; c++) {
        if (nodeResult.columns[c] !== refResult.columns[c]) {
            throw new Error(
                `Column ${c} name differs for ${query}: Node '${nodeResult.columns[c]}' vs C# '${refResult.columns[c]}'.`
            );
        }
    }
    if (nodeResult.rows.length !== refRows.length) {
        throw new Error(`Row count differs for ${query}: Node ${nodeResult.rows.length} vs C# ${refRows.length}.`);
    }
    for (let r = 0; r < nodeResult.rows.length; r++) {
        const leftRow = nodeResult.rows[r];
        const rightRow = refRows[r];
        if (leftRow.length !== rightRow.length) {
            throw new Error(`Row ${r} width differs for ${query}: Node ${leftRow.length} vs C# ${rightRow.length}.`);
        }
        for (let c = 0; c < leftRow.length; c++) {
            const outcome = checkCell(leftRow[c], rightRow[c], refTypes[c]);
            if (outcome === undefined) {
                throw new Error(
                    `Row ${r} col ${c} ('${nodeResult.columns[c]}') differs for ${query}: ` +
                        `Node ${JSON.stringify(leftRow[c])} vs C# ${JSON.stringify(rightRow[c])}.`
                );
            }
        }
    }
}

async function readNodeResult(connection, query) {
    const reader = await connection.createCommand(query).executeReader();
    try {
        const columns = Array.from({ length: reader.fieldCount }, (_, index) => reader.getName(index));
        const rows = [];
        while (await reader.read()) {
            rows.push(Array.from({ length: reader.fieldCount }, (_, index) => normalize(reader.getValue(index))));
        }
        return { columns, rows };
    } finally {
        await reader.close();
    }
}

module.exports = {
    RUNNER_PROJECT,
    RUNNER_DLL,
    DATETIME_SKEW_ALLOWANCE_MS,
    DECIMAL_SIGNIFICANT_DIGITS,
    isDotnetAvailable,
    ensureBuilt,
    runBatch,
    runSingle,
    normalize,
    normalizeReference,
    toComparableRows,
    roundToSignificantDigits,
    assertReferenceEqual,
    readNodeResult,
};
