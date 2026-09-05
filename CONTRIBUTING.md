# Contributing to @justybase/netezza-driver

Thank you for your interest in contributing to the Netezza Node.js Driver! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing](#testing)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers via GitHub.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples** (code snippets, SQL queries)
- **Describe the behavior you observed and expected**
- **Include your environment details**:
  - Node.js version (`node --version`)
  - Package version
  - Operating system
  - Netezza server version (if applicable)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion:

- **Use a clear and descriptive title**
- **Provide a detailed description of the suggested enhancement**
- **Explain why this enhancement would be useful**
- **List any alternative solutions you've considered**

### Pull Requests

- Fill in the required template
- Follow the coding standards
- Include tests for new functionality
- Update documentation when necessary
- Ensure all tests pass

## Development Setup

### Prerequisites

- Node.js 22.0.0 or higher (CI runs 22 and 24; published package requires >=22.0.0)
- npm 9.0.0 or higher
- TypeScript 7.x

### Getting Started

1. **Fork the repository** on GitHub

2. **Clone your fork locally**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/justybase_netezza_node_driver.git
   cd justybase_netezza_node_driver
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Build the project**:
   ```bash
   npm run build
   ```

5. **Run offline unit tests** (no Netezza required):
   ```bash
   npm run test:unit
   ```

6. **Run smoke tests** (requires a live Netezza server and `NZ_DEV_*` / `NZ_USE_LAB_DEFAULTS`):
   ```bash
   npm run test:smoke
   ```

### Project Structure

```
justybase_netezza_node_driver/
src/
  index.ts              # Public exports
  NzConnection.ts       # Main connection class
  NzCommand.ts          # Command execution
  NzDataReader.ts       # Data reader implementation
  Handshake.ts          # Connection handshake protocol
  DbosTupleDesc.ts      # Tuple descriptor
  protocol/
    constants.ts        # Protocol constants
  types/
    TypeConversions.ts  # Type conversion utilities
  utils/
    PGUtil.ts
tests/                  # Test files
tools/examples/         # Example scripts
```

## Pull Request Process

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the coding standards

3. **Add or update tests** for your changes (runtime tests and, when the public
   API types change, the compile-time tests under `tests/types/`)

4. **Run the quality gate** (no database required):
   ```bash
   npm run check   # format + lint (Biome) + typecheck + compile-time type tests
   ```

5. **Run the test suite** (requires a live Netezza server):
   ```bash
   npm run test:smoke  # Quick validation
   npm run test:full   # Comprehensive tests
   ```

6. **Build the project**:
   ```bash
   npm run build
   ```

7. **Commit your changes** with a clear commit message:
   ```bash
   git commit -m "feat: add support for new data type"
   ```

8. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

9. **Create a Pull Request** on GitHub

### Commit Message Guidelines

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

Examples:
```
feat: add support for NUMERIC data type
fix: resolve connection timeout issue
docs: update README with SSL configuration examples
test: add tests for NULL value handling
```

## Coding Standards

### TypeScript Guidelines

- Use strict TypeScript configuration
- Provide JSDoc comments for public APIs
- Use meaningful variable and function names
- Avoid `any` type when possible
- Use interfaces for configuration objects
- Run `npm run lint` (Biome) and `npm run typecheck` before submitting
- Extend the compile-time type tests under `tests/types/` (run via
  `npm run typecheck:types`) whenever the public API types change

### Code Style

- Use 4 spaces for indentation
- Use semicolons
- Use single quotes for strings
- Maximum line length: 120 characters

### Example Code Style

```typescript
/**
 * Establishes a connection to the Netezza database.
 * @returns Promise that resolves when connection is established
 * @throws Error if connection fails
 */
async open(): Promise<void> {
    if (this._connected) {
        throw new Error('Connection is already open');
    }
    // Implementation...
}
```

## Testing

### Smoke Tests

Quick validation tests that **require a live Netezza server** and `NZ_DEV_PASSWORD`:

```bash
npm run test:smoke
```

### Full Tests

Comprehensive tests requiring a Netezza server connection:

```bash
# Set the password environment variable
export NZ_DEV_PASSWORD=your_password  # Linux/macOS
set NZ_DEV_PASSWORD=your_password     # Windows

npm run test:full
```

### Writing Tests

- Place test files in the `tests/` directory
- Use `.test.js` extension for regular tests
- Use `.smoke.test.js` extension for smoke tests
- Use `.test-d.ts` files under `tests/types/` for compile-time type tests
- Follow the existing test patterns

## Questions?

If you have questions about contributing, please open an issue with the `question` label.

Thank you for contributing!
