# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.1]: https://github.com/KrzysztofDusko/netezza-driver/releases/tag/v1.0.1
[1.0.0]: https://github.com/KrzysztofDusko/netezza-driver/releases/tag/v1.0.0

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

[1.1.0]: https://github.com/KrzysztofDusko/netezza-driver/releases/tag/v1.1.0
