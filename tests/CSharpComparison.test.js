/**
 * Full suite - C# JustyBase.NetezzaDriver vs Node compatibility.
 *
 * Ported 1:1 from the removed ODBC comparison suite (query corpus lives in
 * tests/helpers/referenceQueries.js). Comparison is strict (column names +
 * values); the closed list of representation equivalences lives in
 * tests/helpers/csharpReference.js (checkCell), and skipped queries in
 * knownDivergences below.
 *
 * Local-only: requires a live Netezza server (NZ_DEV_HOST + NZ_DEV_PASSWORD,
 * or NZ_USE_LAB_DEFAULTS=1) and `dotnet`. Not part of `npm run test:full`;
 * run explicitly via `npm run test:reference:full`.
 */

const { NzConnection } = require('../dist/cjs/NzConnection');
const { getNzConfig } = require('./helpers/env');
const {
    isDotnetAvailable,
    ensureBuilt,
    runBatch,
    assertReferenceEqual,
    readNodeResult,
} = require('./helpers/csharpReference');
const { queries, queryManyTypes2, systemQueries, intervalTimeTestCases } = require('./helpers/referenceQueries');

const config = (() => {
    try {
        return getNzConfig();
    } catch {
        return null;
    }
})();

const describeReference = config && isDotnetAvailable() ? describe : describe.skip;

const standardQueries = queries;
const fullSystemQueries = [queryManyTypes2, ...systemQueries];

/**
 * Documented divergences: queries skipped with a reason instead of running.
 * Add entries only after confirming on a live server that the difference is a
 * genuine Node<->C# contract gap and not a driver bug.
 */
const knownDivergences = [
    {
        // Also skipped against ODBC: native NUMERIC scale mismatch
        // (e.g. 6.71231 vs 0.0000671231).
        pattern: '_V_RELATION_COLUMN_XDB',
        reason: 'native NUMERIC scale divergence, see ported ODBC comment',
    },
];

function divergenceReason(query) {
    const upper = query.toUpperCase();
    const hit = knownDivergences.find((d) => upper.includes(d.pattern.toUpperCase()));
    return hit ? hit.reason : null;
}

async function compareAgainstReference(nzConn, query) {
    const nodeResult = await readNodeResult(nzConn, query);
    const [ref] = runBatch([query]);
    try {
        assertReferenceEqual(nodeResult, ref, query);
    } catch (_e) {
        // System catalog views can change between the Node and C# reads
        // (two connections, seconds apart). One retry separates flakes from
        // real divergences.
        const nodeRetry = await readNodeResult(nzConn, query);
        const [refRetry] = runBatch([query]);
        assertReferenceEqual(nodeRetry, refRetry, query);
        if (nodeRetry.rows.length !== nodeResult.rows.length) {
            console.warn(`Flaky row count on retry (catalog moved under test): ${query}`);
        }
    }
}

function formatTimeValue(val) {
    if (typeof val === 'object' && val !== null && val.hours !== undefined) {
        return `${String(val.hours).padStart(2, '0')}:${String(val.minutes).padStart(2, '0')}:${String(
            val.seconds
        ).padStart(2, '0')}`;
    }
    return String(val);
}

function getTypeName(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (val instanceof Date) return 'Date';
    if (Array.isArray(val)) return 'Array';
    if (typeof val === 'object') return 'Object';
    const t = typeof val;
    return t.charAt(0).toUpperCase() + t.slice(1);
}

describeReference('C# vs Node consistency - standard', () => {
    let nzConn = null;

    beforeAll(async () => {
        ensureBuilt();
        nzConn = new NzConnection(config);
        await nzConn.connect();
    }, 300000);

    afterAll(async () => {
        if (nzConn) await nzConn.close();
    });

    const runnable = standardQueries.filter((q) => !divergenceReason(q));

    test.each(runnable)('Query should match C# reference: %s', async (query) => {
        await compareAgainstReference(nzConn, query);
    }, 120000);
});

describeReference('C# vs Node consistency - system', () => {
    let nzConn = null;

    beforeAll(async () => {
        ensureBuilt();
        nzConn = new NzConnection(config);
        await nzConn.connect();
    }, 300000);

    afterAll(async () => {
        if (nzConn) await nzConn.close();
    });

    const runnable = fullSystemQueries.filter((q) => !divergenceReason(q));

    test.each(runnable)('Query should match C# reference: %s', async (query) => {
        await compareAgainstReference(nzConn, query);
    }, 120000);
});

describeReference('Expected Interval/Time Values', () => {
    let nzConn;

    beforeAll(async () => {
        nzConn = new NzConnection(config);
        await nzConn.connect();
    }, 300000);

    afterAll(async () => {
        if (nzConn) await nzConn.close();
    });

    test.each(intervalTimeTestCases)(
        'Query: %s => Expected: %s (%s)',
        async (query, expectedValue, expectedType) => {
            const nzCmd = nzConn.createCommand(query);
            const nzReader = await nzCmd.executeReader();

            try {
                expect(await nzReader.read()).toBe(true);

                const val = nzReader.getValue(0);
                const formattedValue = formatTimeValue(val);
                const actualType = getTypeName(val);

                expect(formattedValue).toBe(expectedValue);
                expect(actualType).toBe(expectedType);
            } finally {
                await nzReader.close();
            }
        },
        120000
    );
});

// Re-export for tooling that counts the corpus without running Jest.
module.exports.__corpusStats = () => ({
    standard: standardQueries.length,
    system: fullSystemQueries.length,
    interval: intervalTimeTestCases.length,
    skipped: standardQueries.concat(fullSystemQueries).filter((q) => divergenceReason(q)).length,
});
