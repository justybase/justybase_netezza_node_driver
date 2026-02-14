const { NzConnection } = require('../dist/NzConnection');

const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

describe('AuthenticationTests', () => {

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
