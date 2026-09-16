/**
 * Jest configuration for driver tests
 *
 * Usage:
 *   jest --config jest.config.js                    # Run all tests (full)
 *   npm test / npm run test:smoke                   # Smoke tests (needs NZ)
 *   npm run test:unit                               # Offline unit tests (CI)
 *   npm run test:full                               # All tests
 */

module.exports = {
    testEnvironment: 'node',
    maxWorkers: 1,
    testTimeout: 120000,
    setupFilesAfterEnv: [],
    testMatch: ['**/tests/**/*.test.js', '**/tests/**/*.unit.test.js'],
    testPathIgnorePatterns: [
        '/node_modules/',
        '/dist/',
        // Local-only C# reference full suite (~700 live queries, needs NZ + dotnet).
        // Run explicitly via `npm run test:reference:full` (it overrides this
        // ignore via --testPathIgnorePatterns).
        '/tests/CSharpComparison\\.test\\.js$',
    ],
    moduleNameMapper: {},
    // Tests intentionally load the built CommonJS package. Measure the code
    // that the package actually executes; Jest has no TypeScript transformer.
    collectCoverageFrom: ['dist/cjs/**/*.js'],
    coverageProvider: 'v8',
    verbose: true,
    bail: 0,
    clearMocks: true,
    transform: {},
};
