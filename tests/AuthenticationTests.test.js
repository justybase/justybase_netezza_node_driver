const { NzConnection } = require('../dist/cjs/NzConnection');

const { getNzConfig } = require('./helpers/env');
const config = (() => { try { return getNzConfig(); } catch (e) { return null; } })();
const describeNz = config ? describe : describe.skip;


describeNz('AuthenticationTests', () => {

    test('Open_WithInvalidPassword_ThrowsNetezzaException', async () => {
        const invalidConfig = {
            ...config,
            password: 'WrongPassword123!'
        };
        const connection = new NzConnection(invalidConfig);

        // Expect to throw
        await expect(connection.connect()).rejects.toThrow(/password authentication failed/i);

        connection.close();
    });

});
