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