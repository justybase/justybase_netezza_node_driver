const { NzDataReader } = require('../dist/NzDataReader');
const { NzCommand } = require('../dist/NzCommand');

// Mock NzCommand for testing
class MockNzCommand {
    _preparedStatement = null;
}

/**
 * Creates a mock async generator that yields specified items
 */
async function* createMockGenerator(items) {
    for (const item of items) {
        yield item;
    }
}

describe('NzDataReader - Stack Overflow Prevention', () => {
    
    test('should handle many consecutive CommandComplete without stack overflow', async () => {
        // Simulate 5000 consecutive CommandComplete messages
        // This would cause stack overflow with recursive read() calls
        const itemCount = 5000;
        const items = [];
        
        for (let i = 0; i < itemCount; i++) {
            items.push({ type: 'CommandComplete' });
        }
        // End with ReadyForQuery to properly finish
        items.push({ type: 'ReadyForQuery' });
        
        const mockCommand = new MockNzCommand();
        const generator = createMockGenerator(items);
        
        const reader = new NzDataReader(
            mockCommand,
            generator,
            [], // empty columns
            null, // no release callback
            null  // no initial next item
        );
        
        // This should not throw stack overflow error
        const result = await reader.read();
        
        // After processing all CommandComplete and hitting ReadyForQuery,
        // read() should return false (no more data)
        expect(result).toBe(false);
        expect(reader.isClosed).toBe(false);
        
        await reader.close();
    }, 30000);

    test('should handle CommandComplete followed by DataRow', async () => {
        const items = [
            { type: 'CommandComplete' },
            { type: 'CommandComplete' },
            { type: 'DataRow', row: [42] }
        ];
        
        const mockCommand = new MockNzCommand();
        const generator = createMockGenerator(items);
        
        const reader = new NzDataReader(
            mockCommand,
            generator,
            [{ name: 'test', typeOid: 23, typeMod: -1, typeLen: 4 }],
            null,
            null
        );
        
        const result = await reader.read();
        expect(result).toBe(true);
        expect(reader.getValue(0)).toBe(42);
        
        await reader.close();
    });

    test('should handle interleaved CommandComplete and RowDescription', async () => {
        const items = [
            { type: 'CommandComplete' },
            { type: 'RowDescription', columns: [{ name: 'col1', typeOid: 23, typeMod: -1, typeLen: 4 }] },
            { type: 'CommandComplete' },
            { type: 'DataRow', row: [100] }
        ];
        
        const mockCommand = new MockNzCommand();
        const generator = createMockGenerator(items);
        
        const reader = new NzDataReader(
            mockCommand,
            generator,
            [],
            null,
            null
        );
        
        // First read should encounter CommandComplete, then RowDescription
        // RowDescription sets _pendingColumns and returns false
        const result1 = await reader.read();
        expect(result1).toBe(false);
        expect(reader._pendingColumns).not.toBeNull();
        
        await reader.close();
    });

    test('should handle many CommandComplete between result sets', async () => {
        // Simulate multiple result sets with many CommandComplete between them
        // Note: RowDescription sets _pendingColumns and returns false from read()
        // User must call nextResult() to move to next result set
        const items = [
            { type: 'DataRow', row: [1] },
            { type: 'CommandComplete' },
            { type: 'CommandComplete' },
            { type: 'CommandComplete' },
            { type: 'RowDescription', columns: [{ name: 'name', typeOid: 1043, typeMod: -1, typeLen: -1 }] },
            { type: 'DataRow', row: ['test'] },
            { type: 'ReadyForQuery' }
        ];
        
        const mockCommand = new MockNzCommand();
        const generator = createMockGenerator(items);
        
        // Initialize with column description
        const reader = new NzDataReader(
            mockCommand,
            generator,
            [{ name: 'id', typeOid: 23, typeMod: -1, typeLen: 4 }],
            null,
            null
        );
        
        // Read first row
        const result1 = await reader.read();
        expect(result1).toBe(true);
        expect(reader.getValue(0)).toBe(1);
        
        // Move to next result set (processes CommandComplete messages internally)
        const hasNext = await reader.nextResult();
        expect(hasNext).toBe(true);
        
        // Read row from second result set
        const result2 = await reader.read();
        expect(result2).toBe(true);
        expect(reader.getValue(0)).toBe('test');
        
        await reader.close();
    });
});
