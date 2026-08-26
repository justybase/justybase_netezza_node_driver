# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.5] - 2026-08-26

### Fixed
- Streaming readers now report the end of the current result set as soon as Netezza sends `CommandComplete`, without waiting for the later `ReadyForQuery`. Call `nextResult()` to advance to another row-returning result, or `close()` to drain the remaining protocol messages and release the connection.
- Async iteration now closes and drains streaming readers automatically after natural completion, releasing the connection for the next command.
- SQL parameter substitution now ignores placeholders inside quoted strings, identifiers, comments, and dollar-quoted bodies.
- Length-prefixed protocol fields and DBOS row bounds are validated defensively; malformed responses poison the connection and require reconnecting instead of allowing an unsafe connection to return to a pool.
- Legacy Netezza authentication errors returned as NUL-terminated text are now surfaced as database errors while malformed binary response lengths remain rejected.
- Pool shutdown and handshake/connection timeout races now reject pending checkouts and cannot resurrect removed clients.
- CI now tests Node.js 18, 20, and 22 and reports coverage for the offline unit suite.

## [2.4.4] - 2026-08-19

### Fixed
- Virtual external-table imports now send all `DATA` frames before the terminal `DONE` frame, preventing buffered streams from being truncated or rolled back.
- Added unit and live integration coverage for virtual import streams, backpressure, progress reporting, and stream failures.

## [2.4.3] - 2026-08-19

### Added
- Configurable `clientType` for object-based connections. The default is the IBM Node.js client type `15`, with `ClientTypeId.SqlDotnet` (`11`) and other signed 16-bit values available for compatibility.

## [2.4.2] - 2026-08-18

### Changed
- `commandTimeout` now rejects `execute()` / `executeReader()` immediately with `Command execution timeout`; `cancel()` runs in the background. The previous `Command execution timeout (Cancel failed: ...)` variant is gone, and the timeout can no longer lose the race to a concurrent `Socket closed/ended during read` error.

### Fixed
- Race between `connection.close()` and a timed-out `executeReader()`: `close()` waits for the in-flight protocol read to settle before clearing `_stream`, so listener cleanup no longer throws `TypeError: Cannot read properties of null (reading 'removeListener')`.
- Read paths (`_ensureBufferData`, `_readBytesSlow`, `_feedBuffer`) use a locally captured stream and throw a clean `Connection is closed` error instead of a `TypeError` when a reader is consumed after the connection has been closed.
- Idempotent listener cleanup in `_waitForReadable` (single-settle guard).
- If an `executeReader()` times out but the underlying execution still completes, the orphaned reader is now closed so `_executing` is released and the connection is not permanently blocked.

## [2.4.1] - 2026-07-25

### Fixed
- Reject execute/query while the connection is closing or already closed (`_closing` / `_connected` guards).
- `connection.execute(sql)` / `executeNonQuery` now report SELECT row counts (from CommandComplete when present, otherwise drained row count) instead of leaving `-1`.
- External-table socket writes settle only after the write callback (or drain), so a late write error cannot be ignored after an early resolve.

## [2.4.0] - 2026-07-25

### Added
- pg-style `connection.query()` / `pool.query()` returning buffered `QueryResult` (`rows`, `rowCount`, `fields`, `notices`).
- Connection URI support via `parseConnectionString` and `new NzConnection('netezza://...')` / `nz://`.
- Structured `NzDatabaseError` with PostgreSQL-style field parsing (`severity`, SQLSTATE `code`, detail, hint).
- Shared SQL parameter helpers (`escapeLiteral`, `substituteParameters`) with honest client-side escaping semantics.
- Socket transport abstraction (`SocketTransport`) for clearer I/O boundaries.
- Offline unit tests (`npm run test:unit`) for parameters, errors, and connection strings; CI runs them on every push/PR.
- Dual CJS + ESM package layout (`dist/cjs`, `dist/esm`) with `exports` / `module` / `sideEffects: false`.
- Typedoc script (`npm run docs`); TypeDoc still peers on TypeScript 6.x, so the repo uses `legacy-peer-deps` (see `.npmrc`).
- `NOTICE` included in the published package.
- Dependabot updates for GitHub Actions; npm publish with `--provenance` and release-tag/version assertion.
- `.env.example` and `getNzConfig` test helper (`NZ_DEV_*`, `NZ_USE_LAB_DEFAULTS`).

### Changed
- Package version **2.4.0**; Node `engines` softened to `>=18.18.0`.
- TypeScript bumped to ^7.0.2.
- Integration tests no longer hardcode lab host credentials; suites skip when env is missing.
- README leads with pg-style quick start; ADO.NET API documented as a secondary streaming style.

## [2.3.3] - 2026-07-24

### Fixed
- Kept TypeScript on the 6.x line for `ts-jest` peer compatibility after the 2.3.2 tooling experiment.

### Changed
- Release packaging and dependency alignment for a clean 2.3.x publish.
- Removed `ts-jest` from the development toolchain once it was no longer required.

## [2.3.2] - 2026-07-24

### Changed
- Removed ESLint from the development toolchain.
- Attempted a TypeScript 7 bump (later reverted in 2.3.3 for peer-dependency compatibility).

> Note: This version may not have published cleanly to npm; prefer 2.3.3 or later.

## [2.3.1] - 2026-07-24

### Fixed
- Drain orphaned/stale backend protocol responses before starting the next query so the connection stays in sync after cancelled or interrupted work.

### Changed
- Dependency upgrades bundled with the 2.3.x maintenance line.

## [2.3.0] - 2026-07-11

### Changed
- Further optimized DBOS row parsing for large result sets.
- Dependency upgrades in `package-lock.json`.

## [2.2.0] - 2026-05-23

### Added
- Parameter support on `NzCommand` / `createCommand`, including parameter substitution during query execution.
- Cancel-operation timeout support.

### Changed
- Enhanced SSL security handling.
- Optimized DBOS row parsing with buffer-based parsers and batch processing.
- Refactored `TimeValue` to avoid duplicated type definitions.
- Cross-platform debug test script improvements.

### Fixed
- Prevented stale command cancellations from disrupting later work.
- Improved `readBytes` to accumulate partial socket reads until the required byte count is available.
- Simplified command-number initialization and increment logic.

## [2.1.0] - 2026-05-16

### Added
- Built-in connection pool (`NzPool`) with configurable limits, timeouts, and idle management.
- Comprehensive pool and notice-handling tests.

### Changed
- Updated development dependencies.

## [2.0.0] - 2026-04-03

### Breaking Changes
- Loose text-protocol queries now return the same JavaScript value types as table-backed binary queries when the server exposes a known type OID. Queries such as `SELECT true::BOOLEAN`, `SELECT '2024-12-11'::DATE`, `SELECT '2024-12-11 14:30:00'::TIMESTAMP`, and `SELECT 12345::BIGINT` no longer come back as raw strings.
- `BOOL` now returns `boolean`, `BYTEINT`/`INT2`/`INT4`/`OID` return `number`, `INT8` returns `bigint`, `DATE`/`TIMESTAMP`/`TIMESTAMPTZ`/`ABSTIME` return `Date`, and `NUMERIC` follows the same precision-preserving `number | string` rule on both protocol paths.

### Changed
- Reduced row-decoding overhead in both text and binary paths by caching per-column parsers, precomputing null-bitmap lookups, caching reader metadata, and replacing the legacy binary `NUMERIC` decoder with a `BigInt`-based implementation.
- `getSchemaTable()` and `getColumnMetadata()` now report `BigInt` for `INT8` columns so schema metadata matches the runtime value contract introduced in `2.0.0`.
- Consolidated the unreleased 1.1.1 metadata work into this release so the changelog reflects the actual published history.

### Fixed
- Unified text-protocol `DataRow` conversion with the existing binary/DBOS conversion contract so `SELECT ...` and `SELECT ... FROM table` no longer disagree on value types for booleans, integers, numerics, dates, timestamps, and known system OIDs.
- `getSchemaTable().Rows[].AllowDBNull` now uses DBOS tuple-descriptor nullability when available instead of always reporting `true`.
- SSL tests no longer depend on hardcoded `D:\DEV\Others\keys\...` paths. The valid-certificate test is now gated by `NZ_SSL_CERT_PATH`, and the invalid-certificate fixture is created in the system temp directory.
- External-table tests and example scripts no longer depend on machine-specific temp paths such as `C:\DEV\TMP`; they now use `NZ_LOCAL_TMP_DIR` or the operating-system temp directory.
- Corrected live Netezza metadata mapping for Unicode text OIDs: `2530` now reports `NVARCHAR` instead of `DATE`, and `2522` now reports `NCHAR` instead of `UNKNOWN(2522)`.
- Kept `DATE` mapping exclusive to provider OID `1082` and aligned `getSchemaTable()` with `getTypeName()` so Unicode text families stay string-like.
- Preserved declared character lengths from `typeMod` in metadata and schema rows for character families such as `VARCHAR(32)`, `NVARCHAR(32)`, and `NCHAR(8)`.
- Added live metadata mappings for `BYTEINT` (`2500`), system `OID` (`26`), and system `ABSTIME` (`702`) so these no longer surface as `UNKNOWN(...)`.

### Added
- Added regression coverage for typed loose `BOOLEAN`, `DATE`, `TIMESTAMP`, and `NUMERIC` queries so text-protocol consistency is enforced in smoke/full tests.
- Added numeric-conversion parity tests and an appliance-backed scenario benchmark harness for measuring real performance changes before keeping them.
- Added public metadata helpers on `NzDataReader`: `getProviderType()`, `getTypeModifier()`, `getTypeLength()`, `getDeclaredTypeName()`, and `getColumnMetadata()`.
- Added live smoke/full coverage for `VARCHAR`, `NVARCHAR`, `NCHAR`, `NATIONAL CHARACTER VARYING`, `CURRENT_DATE`, and `CURRENT_TIMESTAMP` metadata.
- Added live smoke coverage for `BYTEINT`, `_V_TABLE.OBJID` (`OID`), and `_V_TABLE.CREATEDATE` (`ABSTIME`) metadata.

## [1.1.0] - 2026-02-16

### Breaking Changes

⚠️ **This release contains breaking changes for TypeScript users.**

#### Changed return types from `any` to `unknown`

The following methods now return `unknown` instead of `any`, requiring explicit type assertions:

- `NzDataReader.getValue(index)` - Returns `unknown` instead of `any`
- `NzDataReader.getValueByName(name)` - Returns `unknown` instead of `any`
- `NzDataReader.getValues()` - Returns `unknown[]` instead of `any[]`
- `NzDataReader.getRowObject()` - Returns `Record<string, unknown>` instead of `Record<string, any>`
- `NzDataReader.currentRow` - Is now `unknown[]` instead of `any[]`

**Migration guide:**
```typescript
// Before (1.0.x)
const value = reader.getValue(0);
const str = value.toUpperCase(); // No error

// After (1.1.0)
const value = reader.getValue(0) as string; // Or use specific getters
const str = reader.getString(0); // Recommended
```

#### Changed return type of `NzCommand.execute()`
- Now returns `Promise<boolean>` instead of `Promise<void>`
- This may affect code that explicitly checked for void return type

### Changed
- Strengthened TypeScript typings and refactors across `src/NzCommand.ts`, `src/NzConnection.ts`, and `src/NzDataReader.ts` (improved interfaces, `unknown` types, exported generator/column types).
- Improved buffer-pool and streaming read logic in `NzConnection` for better performance and lower GC pressure.
- Added external table log handling: saving `.nzlog`, `.nzbad`, and `.nzstats` files to configured `LOGDIR` during external table operations.
- Fixed command/reader return types, timeout handling, and error typing for safer runtime behavior.
- Added/updated tests in `tests/ExternalTableTests.test.js` covering external table logging and `.nzbad` import scenarios.

## [1.0.1] - 2026-02-14

### Changed
- Version bump to 1.0.1 for release

## [1.0.0] - 2025-02-14

### Added
- Initial release of `@justybase/netezza-driver`
- Native TypeScript driver for IBM Netezza / PureData System for Analytics
- Direct connection to Netezza databases without ODBC drivers or external dependencies
- ADO.NET-style API with Connection/Command/Reader pattern
- SSL/TLS support for encrypted connections
- Full TypeScript type definitions and declarations
- High-performance buffer pooling for large result sets
- Support for all Netezza data types with proper type conversions
- Query cancellation support
- External table operations (import/export)
- Transaction handling
- Connection timeout configuration
- Comprehensive test suite (smoke tests + full tests)
- GitHub Actions CI/CD pipeline
- Apache 2.0 license

### Technical Details
- Pure TypeScript implementation with no native bindings
- Compatible with Node.js 18.0.0 and above
- Supports CommonJS module format
- Includes debug logging support via `debug` package

[2.4.3]: https://github.com/justybase/justybase_netezza_node_driver/compare/2.4.2...2.4.3
[2.3.3]: https://github.com/justybase/justybase_netezza_node_driver/compare/2.3.2...2.3.3
[2.3.2]: https://github.com/justybase/justybase_netezza_node_driver/compare/2.3.1...2.3.2
[2.3.1]: https://github.com/justybase/justybase_netezza_node_driver/compare/2.3.0...2.3.1
[2.3.0]: https://github.com/justybase/justybase_netezza_node_driver/compare/2.2.0...2.3.0
[2.2.0]: https://github.com/justybase/justybase_netezza_node_driver/compare/2.1.0...2.2.0
[2.1.0]: https://github.com/justybase/justybase_netezza_node_driver/compare/2.0.0...2.1.0
[2.0.0]: https://github.com/justybase/justybase_netezza_node_driver/compare/1.1.0...2.0.0
[1.1.0]: https://github.com/justybase/justybase_netezza_node_driver/compare/1.0.1...1.1.0
[1.0.1]: https://github.com/justybase/justybase_netezza_node_driver/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/justybase/justybase_netezza_node_driver/releases/tag/1.0.0
