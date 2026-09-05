/**
 * Typed query / reader example.
 *
 * Demonstrates the generic API surface:
 * - `connection.query<Row>()` and `pool.query<Row>()` returning `rows: Row[]`
 * - `command.executeReader<Row>()` / `connection.executeReader<Row>()` with a
 *   typed `getRowObject()`, typed async iteration, and typed `getValues()`
 *
 * Requires a live Netezza server. Set `NZ_DEV_HOST` / `NZ_DEV_PASSWORD` (plus
 * optional `NZ_DEV_PORT`, `NZ_DEV_DATABASE`, `NZ_DEV_USER`) before running.
 *
 * Run with a TypeScript runner, e.g.:
 *     npx tsx tools/examples/typed_query.ts
 *
 * Note: inside this repository the example imports the driver source for
 * type-checking. In your own application import the published package:
 *     import { NzConnection, NzPool } from '@justybase/netezza-driver';
 */
import { NzConnection, NzPool, type NzConnectionConfig } from '../../src/index';

interface DimTableRow {
    TABLENAME: string;
    OBJID: number;
}

const host = process.env.NZ_DEV_HOST;
const password = process.env.NZ_DEV_PASSWORD;

function config(): NzConnectionConfig {
    return {
        host: host ?? 'localhost',
        port: Number(process.env.NZ_DEV_PORT || '5480'),
        database: process.env.NZ_DEV_DATABASE || 'system',
        user: process.env.NZ_DEV_USER || 'admin',
        password: password ?? '',
    };
}

async function typedQuery(): Promise<void> {
    const connection = new NzConnection(config());
    await connection.connect();

    try {
        // Buffered query: rows are DimTableRow[] — no casts needed.
        const result = await connection.query<DimTableRow>(
            'SELECT TABLENAME, OBJID FROM _V_TABLE WHERE TABLENAME = $1 LIMIT 5',
            ['DIMDATE']
        );
        for (const row of result.rows) {
            console.log(`table: ${row.TABLENAME}, objid: ${row.OBJID}`);
        }
        console.log(`rows: ${result.rows.length}`);

        // Streaming reader: getRowObject(), for await, and getValues() are typed.
        const reader = await connection
            .createCommand('SELECT TABLENAME, OBJID FROM _V_TABLE LIMIT 5')
            .executeReader<DimTableRow>();

        try {
            for await (const row of reader) {
                console.log(`streamed: ${row.TABLENAME} / ${row.OBJID}`);
            }
        } finally {
            await reader.close();
        }
    } finally {
        connection.close();
    }
}

async function typedPoolQuery(): Promise<void> {
    const pool = new NzPool({ ...config(), max: 5 });
    try {
        const result = await pool.query<DimTableRow>('SELECT TABLENAME, OBJID FROM _V_TABLE LIMIT 5');
        const first: DimTableRow | undefined = result.rows[0];
        if (first) {
            console.log(`pool row: ${first.TABLENAME} / ${first.OBJID}`);
        }
    } finally {
        await pool.end();
    }
}

async function main(): Promise<void> {
    if (!host || !password) {
        console.log('Set NZ_DEV_HOST and NZ_DEV_PASSWORD (plus optional NZ_DEV_*) to run this example.');
        return;
    }
    await typedQuery();
    await typedPoolQuery();
}

void main();
