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
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
    ],
    verbose: true,
    bail: 0,
    clearMocks: true,
    transform: {},
};
