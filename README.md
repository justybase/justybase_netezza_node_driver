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
- **SSL/TLS Support**: Encrypted connections to Netezza/PureData.
- **Strongly Typed**: Full TypeScript support for configuration and data handling.

## Installation

```bash
npm install @justybase/netezza-driver
```

## Quick Start

```typescript
import { NzConnection, NzCommand } from '@justybase/netezza-driver';

async function example() {
    const connection = new NzConnection({
        host: 'your-nz-host',
        database: 'system',
        user: 'admin',
        password: 'password',
        // port: 5480, // default
    });

    try {
        await connection.open();
        
        const command = new NzCommand('SELECT * FROM _v_table WHERE tablename LIKE ?', connection);
        command.parameters.push('CUSTOMER%');

        const reader = await command.executeReader();
        
        while (await reader.read()) {
            const tableName = reader.getValue(0);
            console.log(`Found table: ${tableName}`);
        }
        
    } finally {
        await connection.close();
    }
}
```

## Design & lineage

This driver exposes an API and usage patterns inspired by ADO.NET: connection/command/reader abstractions, predictable lifecycle management, and an explicit approach to connection and command disposal. The design mirrors common C# database client patterns to make the library familiar to developers coming from .NET.

Important: this project is an independent TypeScript implementation and does not reuse code from the `node-netezza` package. The functional and architectural inspiration comes from the C# implementation referenced above; that C# project is cited as a design reference in this repository.

> **Note**: The `node-netezza` package is included in this project specifically for **benchmarking** purposes, and `odbc` is included for **testing** purposes to ensure compatibility and correctness.

## Testing

This package has two types of tests:

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

### Other Test Commands

```bash
# Run tests with debug output
npm run test:debug

# Run specific test file
npx jest tests/BasicTests.test.js --config jest.config.js --runInBand
```

## Build

```bash
npm run build
```
