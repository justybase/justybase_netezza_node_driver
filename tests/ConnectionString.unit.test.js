/**
 * Offline unit tests for netezza:// / nz:// connection string parsing.
 */

const { parseConnectionString } = require('../dist/cjs/connectionString');

describe('parseConnectionString', () => {
    test('parses netezza:// URI with port and database', () => {
        const cfg = parseConnectionString(
            'netezza://admin:s3cret@db.example.com:5480/JUST_DATA'
        );
        expect(cfg).toEqual({
            host: 'db.example.com',
            port: 5480,
            database: 'JUST_DATA',
            user: 'admin',
            password: 's3cret',
        });
    });

    test('accepts nz:// alias and default port omission', () => {
        const cfg = parseConnectionString('nz://admin:pw@192.168.0.10/SYSTEM');
        expect(cfg.host).toBe('192.168.0.10');
        expect(cfg.port).toBeUndefined();
        expect(cfg.database).toBe('SYSTEM');
        expect(cfg.user).toBe('admin');
        expect(cfg.password).toBe('pw');
    });

    test('decodes URL-encoded user and password', () => {
        const cfg = parseConnectionString(
            'netezza://user%40corp:p%40ss%2Fw@host.example/db'
        );
        expect(cfg.user).toBe('user@corp');
        expect(cfg.password).toBe('p@ss/w');
        expect(cfg.database).toBe('db');
    });

    test('maps sslmode and query options', () => {
        const cfg = parseConnectionString(
            'netezza://u:p@h/db?sslmode=require&appName=myapp&connectionTimeout=15'
        );
        expect(cfg.securityLevel).toBe('OnlySecuredSession');
        expect(cfg.rejectUnauthorized).toBe(false);
        expect(cfg.appName).toBe('myapp');
        expect(cfg.connectionTimeout).toBe(15);
    });

    test('sslmode=disable maps to OnlyUnsecuredSession', () => {
        const cfg = parseConnectionString('netezza://u:p@h/db?sslmode=disable');
        expect(cfg.securityLevel).toBe('OnlyUnsecuredSession');
    });

    test('rejects missing database path', () => {
        expect(() => parseConnectionString('netezza://u:p@host')).toThrow(/database/i);
    });

    test('rejects missing user', () => {
        expect(() => parseConnectionString('netezza://:p@host/db')).toThrow(/user/i);
    });

    test('rejects invalid URI', () => {
        expect(() => parseConnectionString('not-a-uri')).toThrow(/Invalid connection string/);
    });
});
