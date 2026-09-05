# IBM Netezza / PureData Driver for Node.js (TypeScript)

[![CI Status](https://github.com/justybase/justybase_netezza_node_driver/workflows/CI/badge.svg)](https://github.com/justybase/justybase_netezza_node_driver/actions)
[![npm version](https://img.shields.io/npm/v/@justybase/netezza-driver.svg)](https://www.npmjs.com/package/@justybase/netezza-driver)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@justybase/netezza-driver)](https://nodejs.org)

A native, high-performance **TypeScript reimplementation** of the [JustyBase.NetezzaDriver](https://github.com/justybase/JustyBase.NetezzaDriver).

It allows for direct connection to IBM Netezza / PureData System for Analytics databases **without the need for ODBC drivers** or external dependencies.

## Key Features

- **Pure TypeScript**: No native bindings, no ODBC/CLI required.
- **High Performance**: Optimized for large result sets using internal buffer pooling.
- **pg-style `query()`**: `connection.query()` / `pool.query()` return buffered `QueryResult` (`rows`, `rowCount`, `fields`).
- **ADO.NET Style API**: Familiar Connection/Command/Reader pattern when you need streaming readers.
- **Connection strings**: `netezza://` / `nz://` URIs via `parseConnectionString` or `new NzConnection(uri)`.
- **Connection Pool**: Built-in `NzPool` with configurable limits, timeouts, and idle management.
- **Structured errors**: Backend failures throw `NzDatabaseError` with SQLSTATE / severity / detail when present.
- **Security & Audit**: SSL/TLS, MD5/SHA256 authentication, and Guardium audit metadata.
- **Strongly Typed**: Full TypeScript support; dual CJS + ESM builds.

## Installation

```bash
npm install @justybase/netezza-driver
```

Requires Node.js **>= 22.0.0**.

## Quick Start

```typescript
import { NzConnection } from '@justybase/netezza-driver';

async function example() {
    // Object config or connection string
    const connection = new NzConnection({
        host: 'your-nz-host',
        database: 'system',
        user: 'admin',
        password: 'password',
        // port: 5480, // default
    });
    // const connection = new NzConnection('netezza://admin:password@your-nz-host:5480/system');

    await connection.connect();

    try {
        const result = await connection.query(
            'SELECT TABLENAME FROM _V_TABLE WHERE TABLENAME = $1 LIMIT 5',
            ['DIMDATE']
        );
        for (const row of result.rows) {
            console.log(row.TABLENAME);
        }
        console.log('rowCount:', result.rowCount);
    } finally {
        connection.close();
    }
}
```

### Typed rows

`query()` is generic: pass your row shape as the type argument and `result.rows`
becomes `T[]` instead of `Record<string, unknown>[]`. This works on both
`connection.query<T>()` and `pool.query<T>()`.

```typescript
interface TableRow {
    TABLENAME: string;
    ROWS: number;
}

const result = await connection.query<TableRow>(
    'SELECT TABLENAME, ROWS FROM _V_TABLE WHERE TABLENAME = $1 LIMIT 5',
    ['DIMDATE']
);

// result.rows is TableRow[] — fully typed, no casts needed
for (const row of result.rows) {
    console.log(row.TABLENAME, row.ROWS);
}
```

Without a type argument the rows stay `QueryResultRow`
(`Record<string, unknown>`), preserving the default strict-but-unknown contract.

The streaming API is typed the same way: `executeReader<T>()` on a connection or
`NzCommand` returns an `NzDataReader<T>` whose `getRowObject()` and async
iteration are typed.

```typescript
const reader = await connection
    .createCommand('SELECT TABLENAME FROM _V_TABLE LIMIT 5')
    .executeReader<{ TABLENAME: string }>();

try {
    for await (const row of reader) {
        console.log(row.TABLENAME); // string
    }
} finally {
    await reader.close();
}
```

`getRowObject()` also accepts a per-call type argument, so you can type an
individual row even on a reader created without a type parameter:

```typescript
const row = reader.getRowObject<{ TABLENAME: string }>();
```

### Parameters (honest note)

Netezza’s simple-query path used by this driver does **not** expose server-side bind/prepared parameters. `$1`, `$2`, … placeholders are **escaped client-side** and interpolated into the SQL text before send (`escapeLiteral` / `substituteParameters`). Prefer primitives (`null`, boolean, number, bigint, string, `Date`, `Buffer`); unsupported object shapes are rejected.

### Connection strings

```typescript
import { parseConnectionString, NzConnection } from '@justybase/netezza-driver';

const config = parseConnectionString(
    'netezza://admin:secret@host:5480/JUST_DATA?sslmode=require&appName=myapp'
);
const connection = new NzConnection(config);
// or: new NzConnection('nz://admin:secret@host/JUST_DATA');
```

### Netezza client type

The handshake identifies the connection as a Node.js client by default
(`clientType = 15`). For compatibility with systems that require another
client identity, set `clientType` in the object configuration:

```typescript
import { ClientTypeId, NzConnection } from '@justybase/netezza-driver';

const connection = new NzConnection({
    host: 'your-nz-host',
    database: 'JUST_DATA',
    user: 'admin',
    password: 'password',
    clientType: ClientTypeId.Node,       // 15, default
    // clientType: ClientTypeId.SqlDotnet, // 11, compatibility fallback
});
```

Known identifiers are available as `ClientTypeId`: `Invalid` (-1), `None`
(0), `Sql` (1), `SqlOdbc` (2), `SqlJdbc` (3), `Load` (4), `Client` (5),
`Bnr` (6), `Reclaim` (7), `Unknown` (8), `SqlOledb` (9), `Internal` (10),
`SqlDotnet` (11), `SqlGolang` (12), `SqlPython` (13), `Unknown2` (14), and
`Node` (15). Other signed 16-bit values can also be supplied for server-
specific or future client types. This option is available in object
configuration; connection-string query parameters do not change it.

### Errors

Failed queries and authentication errors throw `NzDatabaseError` (extends `Error`) with optional `severity`, `code` (SQLSTATE), `detail`, `hint`, and `raw` payload fields.

```typescript
import { NzDatabaseError } from '@justybase/netezza-driver';

try {
    await connection.query('SELECT * FROM no_such_table');
} catch (err) {
    if (err instanceof NzDatabaseError) {
        console.error(err.code, err.message, err.detail);
    }
    throw err;
}
```

## Connection Pool (NzPool)

```typescript
import { NzPool } from '@justybase/netezza-driver';

const pool = new NzPool({
    host: 'your-nz-host',
    database: 'system',
    user: 'admin',
    password: 'password',
    max: 10,
    idleTimeoutMillis: 30000,
});

async function runQuery() {
    const result = await pool.query('SELECT 1 AS n');
    console.log(result.rows[0].n);
}
```

## ADO.NET-style API

When you need streaming readers, cancellation, or fine-grained command control, use Connection / Command / Reader:

```typescript
import { NzConnection } from '@justybase/netezza-driver';

async function example() {
    const connection = new NzConnection({
        host: 'your-nz-host',
        database: 'system',
        user: 'admin',
        password: 'password',
    });

    await connection.connect();

    try {
        const reader = await connection
            .createCommand('SELECT TABLENAME FROM _V_TABLE ORDER BY TABLENAME LIMIT 5')
            .executeReader();

        try {
            while (await reader.read()) {
                console.log(`Found table: ${reader.getString(0)}`);
            }
        } finally {
            await reader.close();
        }
    } finally {
        connection.close();
    }
}
```

## Guardium Audit Metadata

```typescript
const connection = new NzConnection({
    // ... basic connection info
    appName: 'MyDataService',
    osUser: 'service-account',
    clientHostName: 'worker-node-1',
});
```

## Design & lineage

This driver exposes both a pg-style buffered `query()` API and ADO.NET-inspired connection/command/reader abstractions. The design mirrors common C# database client patterns for streaming use cases.

Important: this project is an independent TypeScript implementation and does not reuse code from the `node-netezza` package. The functional and architectural inspiration comes from the C# implementation referenced above.

> **Note**: The `node-netezza` package is included for **benchmarking**, and `odbc` is included for **testing** compatibility.

## Testing

Repository CI runs formatting checks, Biome lint, TypeScript typechecks and
compile-time type tests, and offline unit tests on Node 22.x and 24.x. Live
Netezza smoke/full suites stay local. The published package `engines` field
requires `>=22.0.0`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `NZ_DEV_HOST` | Netezza host (**required** for integration tests unless lab defaults) |
| `NZ_DEV_PASSWORD` | Password (**required** unless lab defaults) |
| `NZ_DEV_PORT` | Port (default `5480`) |
| `NZ_DEV_DATABASE` | Database (default `JUST_DATA`) |
| `NZ_DEV_USER` | User (default `admin`) |
| `NZ_USE_LAB_DEFAULTS` | Set to `1` to allow hardcoded lab defaults when host/password are unset |
| `NZ_SSL_CERT_PATH` | Optional trusted cert for SSL tests |
| `NZ_LOCAL_TMP_DIR` | Optional temp dir for external-table tests / examples |

See [`.env.example`](.env.example) for a copy-paste template.

```bash
# Windows (PowerShell)
$env:NZ_DEV_HOST="192.168.0.144"
$env:NZ_DEV_PASSWORD="your_password"

# Linux/macOS
export NZ_DEV_HOST=192.168.0.144
export NZ_DEV_PASSWORD=your_password
```

### Unit tests (offline / CI)

```bash
npm run test:unit
```

Covers SQL parameter escaping, `NzDatabaseError` parsing, and connection-string parsing. No database required.

Compile-time type tests in [`tests/types/`](tests/types) guard the generic
`query<T>()` / `executeReader<T>()` typings (and the typed rows they return):

```bash
npm run typecheck:types
```

### Smoke Tests (Fast)

Requires a live Netezza server and `NZ_DEV_HOST` + `NZ_DEV_PASSWORD` (or `NZ_USE_LAB_DEFAULTS=1`).

```bash
npm test
# or
npm run test:smoke
```

See [LINUX_ODBC_FIX.md](LINUX_ODBC_FIX.md) if ODBC comparison tests fail on Linux due to encoding issues in `node-odbc`.

### Full Tests (Thorough)

```bash
npm run test:full
```

### Quality gate (offline, run in CI)

```bash
npm run check             # format + lint (Biome) + typecheck + type tests
npm run lint              # Biome lint (errors fail the build)
npm run typecheck         # tsc --noEmit on the CJS and ESM configs
npm run typecheck:types   # compile-time type tests (tests/types)
```

### Other Test Commands

```bash
npm run test:debug
npx jest tests/BasicTests.test.js --config jest.config.js --runInBand
```

## Column Metadata

Use the public metadata methods on `NzDataReader` when you need server type information.

```typescript
const reader = await connection
    .createCommand(`
        SELECT
            'AA'::NVARCHAR(32) AS NVC,
            CURRENT_DATE AS CD
        FROM JUST_DATA..DIMACCOUNT
        LIMIT 1
    `)
    .executeReader();

const metadata = reader.getColumnMetadata(0);
console.log(metadata.typeName); // NVARCHAR
console.log(metadata.declaredTypeName); // NVARCHAR(32)
console.log(metadata.providerType); // 2530
```

For compatibility, `getTypeName()` continues to return canonical base names such as `VARCHAR`, `NVARCHAR`, `NCHAR`, `DATE`, and `TIMESTAMPTZ`. Use `getDeclaredTypeName()` or `getColumnMetadata()` when you also need declared lengths like `VARCHAR(32)`.

## Value Conversion

Starting in `2.0.0`, loose text-protocol queries and table-backed binary queries use the same JavaScript value contract whenever the server provides a known type OID.

The main mappings are `BOOL -> boolean`, `BYTEINT`/`INT2`/`INT4`/`OID -> number`, `INT8 -> bigint`, `DATE`/`TIMESTAMP`/`TIMESTAMPTZ`/`ABSTIME -> Date`, `TIME -> TimeValue`, and `NUMERIC -> number | string` using the existing precision-preserving rule.

## Build

```bash
npm run build
```

Produces dual packages under `dist/cjs` (CommonJS) and `dist/esm` (ES modules).

Optional API docs:

```bash
npm run docs
```
