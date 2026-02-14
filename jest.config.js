/**
 * Jest configuration for driver tests
 * 
 * Usage:
 *   jest --config jest.config.js                    # Run all tests (full)
 *   jest --config jest.config.js --testNamePattern="Smoke"  # Run only smoke tests
 *   npm test                                        # Run smoke tests (fast)
 *   npm run test:full                               # Run all tests (thorough)
 */

module.exports = {
    // Test environment
    testEnvironment: 'node',
    
    // Run tests sequentially (required for connection tests)
    maxWorkers: 1,
    
    // Test timeout - 120 seconds for network operations
    testTimeout: 120000,
    
    // Setup files
    setupFilesAfterEnv: [],
    
    // Test match patterns
    testMatch: [
        '**/tests/**/*.test.js'
    ],
    
    // Ignore patterns
    testPathIgnorePatterns: [
        '/node_modules/',
        '/dist/'
    ],
    
    // Module name mapper (if needed for imports)
    moduleNameMapper: {},
    
    // Coverage settings
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts'
    ],
    
    // Verbose output
    verbose: true,
    
    // Fail fast on first error (optional)
    bail: 0,
    
    // Clear mocks between tests
    clearMocks: true,
    
    // Transform settings
    transform: {}
};
