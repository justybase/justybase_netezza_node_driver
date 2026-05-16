# IBM Netezza / PureData Driver for Node.js (TypeScript)

[![CI Status](https://github.com/KrzysztofDusko/netezza-driver/workflows/CI/badge.svg)](https://github.com/KrzysztofDusko/netezza-driver/actions)
[![npm version](https://img.shields.io/npm/v/@justybase/netezza-driver.svg)](https://www.npmjs.com/package/@justybase/netezza-driver)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@justybase/netezza-driver)](https://nodejs.org)

A native, high-performance **TypeScript reimplementation** of the [JustyBase.NetezzaDriver](https://github.com/KrzysztofDusko/JustyBase.NetezzaDriver).

It allows for direct connection to IBM Netezza / PureData System for Analytics databases **without the need for ODBC drivers** or external dependencies.

## Key Features

- **Pure TypeScript**: No native bindings, no ODBC/CLI required.
- **High Performance**: Optimized for large result sets using internal buffer pooling.
- **ADO.NET Style API**: Familiar Connection/Command/Reader pattern.
- **Connection Pool**: Built-in connection pool (`NzPool`) with configurable limits, timeouts, and idle management.
- **Security & Audit**: Supports SSL/TLS, MD5/SHA256 authentication, and Guardium Audit tracking metadata.
- **Strongly Typed**: Full TypeScript support for configuration and data handling.

## Installation

```bash
npm install @justybase/netezza-driver
```

## Quick Start

```typescript
import { NzConnection } from '@justybase/netezza-driver';

async function example() {
    const connection = new NzConnection({
        host: 'your-nz-host',
        database: 'system',
        user: 'admin',
        password: 'password',
        // port: 5480, // default
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

## Connection Pool (NzPool)

For applications handling multiple requests, it is recommended to use the built-in connection pool to reuse connections and avoid the overhead of establishing new sessions.

```typescript
import { NzPool } from '@justybase/netezza-driver';

const pool = new NzPool({
    host: 'your-nz-host',
    database: 'system',
    user: 'admin',
    password: 'password',
    max: 10,                 // max connections
    idleTimeoutMillis: 30000 // close idle connections after 30s
});

async function runQuery() {
    // Simple query execution: connection is automatically checked out and released
    const reader = await pool.query('SELECT 1');
    try {
        await reader.read();
        console.log(reader.getValue(0));
    } finally {
        // Closing the reader releases the connection back to the pool
        await reader.close();
    }
}
```

## Guardium Audit Metadata

You can configure metadata that Netezza will report to IBM Guardium or display in system session tables:

```typescript
const connection = new NzConnection({
    // ... basic connection info
    appName: 'MyDataService',        // defaults to process script name
    osUser: 'service-account',       // defaults to process.env.USER/USERNAME
    clientHostName: 'worker-node-1'  // defaults to os.hostname()
});
```

## Design & lineage

This driver exposes an API and usage patterns inspired by ADO.NET: connection/command/reader abstractions, predictable lifecycle management, and an explicit approach to connection and command disposal. The design mirrors common C# database client patterns to make the library familiar to developers coming from .NET.

Important: this project is an independent TypeScript implementation and does not reuse code from the `node-netezza` package. The functional and architectural inspiration comes from the C# implementation referenced above; that C# project is cited as a design reference in this repository.

> **Note**: The `node-netezza` package is included in this project specifically for **benchmarking** purposes, and `odbc` is included for **testing** purposes to ensure compatibility and correctness.

## Testing

This package has two types of tests.

Repository CI and local test tooling are currently validated on Node 22.x because the ODBC comparison dependency in the dev toolchain now requires Node >=20. The published package `engines` field requires `>=22.0.0`.

### Smoke Tests (Fast)

Quick validation tests that verify basic functionality. These tests run in ~1 second and are suitable for CI/CD pipelines and quick verification during development.

```bash
npm test
# or
npm run test:smoke
```

**What smoke tests cover:**
- Basic connection establishment
- Simple query execution (SELECT 1, SELECT 12345::BIGINT, etc.)
- Core data type handling (integers, floats, strings, dates, NULL)
- Reader API basic functionality
- ODBC comparison for simple queries

### Full Tests (Thorough)

Comprehensive test suite that validates all functionality against a real Netezza database. Requires the `NZ_DEV_PASSWORD` environment variable to be set.

```bash
npm run test:full
```

**What full tests cover:**
- All smoke tests plus:
- Authentication scenarios
- Query cancellation
- External table operations (import/export)
- Schema table retrieval
- Transaction handling
- Timeout handling
- SSL connections
- Multiple result sets
- Error handling for invalid SQL
- Stack overflow prevention
- Comprehensive ODBC comparison tests
- Query consistency across multiple executions

### Test Requirements

For **full tests**, you need:
1. A running Netezza database server
2. Set the `NZ_DEV_PASSWORD` environment variable:
   ```bash
   # Windows (cmd)
   set NZ_DEV_PASSWORD=your_password
   
   # Windows (PowerShell)
   $env:NZ_DEV_PASSWORD="your_password"
   
   # Linux/macOS
   export NZ_DEV_PASSWORD=your_password
   ```
3. For the optional valid-certificate SSL test, set `NZ_SSL_CERT_PATH` to a trusted server certificate file. If it is not set, that one SSL test is skipped while the rest of the suite still runs.
4. External-table tests and example scripts use `NZ_LOCAL_TMP_DIR` when it is set. Otherwise they fall back to the operating system temp directory.

### Other Test Commands

```bash
# Run tests with debug output
npm run test:debug

# Run specific test file
npx jest tests/BasicTests.test.js --config jest.config.js --runInBand
```

## Column Metadata

Use the public metadata methods on `NzDataReader` when you need server type information. This avoids reaching into the internal `columnDescriptions` array just to recover provider OIDs, modifiers, or declared lengths.

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
console.log(metadata.typeModifier); // 48
console.log(metadata.declaredLength); // 32

console.log(reader.getProviderType(1)); // 1082
console.log(reader.getTypeName(1)); // DATE
```

For compatibility, `getTypeName()` continues to return canonical base names such as `VARCHAR`, `NVARCHAR`, `NCHAR`, `DATE`, and `TIMESTAMPTZ`. Use `getDeclaredTypeName()` or `getColumnMetadata()` when you also need declared lengths like `VARCHAR(32)`.

## Value Conversion

Starting in `2.0.0`, loose text-protocol queries and table-backed binary queries use the same JavaScript value contract whenever the server provides a known type OID.

```typescript
const reader = await connection
    .createCommand(`
        SELECT
            true::BOOLEAN AS ok,
            '2024-12-11'::DATE AS d,
            '2024-12-11 14:30:00'::TIMESTAMP AS ts,
            12345::BIGINT AS id
    `)
    .executeReader();

await reader.read();

console.log(reader.getValue(0)); // true
console.log(reader.getValue(1) instanceof Date); // true
console.log(reader.getValue(2) instanceof Date); // true
console.log(typeof reader.getValue(3)); // bigint
```

The main mappings are `BOOL -> boolean`, `BYTEINT`/`INT2`/`INT4`/`OID -> number`, `INT8 -> bigint`, `DATE`/`TIMESTAMP`/`TIMESTAMPTZ`/`ABSTIME -> Date`, `TIME -> TimeValue`, and `NUMERIC -> number | string` using the existing precision-preserving rule. Character types remain strings, and `INTERVAL`/`TIMETZ` remain string-formatted values. For schema inspection, `INT8` columns now report `DataType === BigInt` so metadata matches the runtime value contract.

## Build

```bash
npm run build
```
