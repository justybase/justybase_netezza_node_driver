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
    testMatch: [
        '**/tests/**/*.test.js',
        '**/tests/**/*.unit.test.js',
    ],
    testPathIgnorePatterns: [
        '/node_modules/',
        '/dist/',
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
