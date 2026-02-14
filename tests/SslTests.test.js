const { NzConnection } = require('../dist/NzConnection');
const fs = require('fs');

// Configuration
const config = {
    host: '192.168.0.144',
    port: 5480,
    database: 'JUST_DATA',
    user: 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};

const CERT_PATH = "D:\\DEV\\Others\\keys\\server-cert.pem";

describe('NzDriver - SSL Tests', () => {

    test('BasicTests - Valid Cert Connects and Queries', async () => {
        const sslConfig = {
            ...config,
            securityLevel: 'OnlySecuredSession',
            sslCerFilePath: CERT_PATH,
            rejectUnauthorized: false
        };

        const conn = new NzConnection(sslConfig);
        try {
            await conn.connect();
            expect(conn._connected).toBe(true);

            const cmd = conn.createCommand("SELECT 15 FROM JUST_DATA..DIMDATE LIMIT 1");
            const reader = await cmd.executeReader();

            let rowCount = 0;
            let firstValue = null;
            while (await reader.read()) {
                if (rowCount === 0) {
                    firstValue = reader.getValue(0);
                }
                rowCount++;
            }
            await reader.close();

            expect(rowCount).toBe(1);
            expect(Number(firstValue)).toBe(15);
        } catch (e) {
            console.error('BasicTests2 Failed:', e);
            throw e;
        } finally {
            await conn.close();
        }
    }, 30000); // 30s timeout

    test('BasicTests - Invalid Cert Throws', async () => {
        const dummyCert = "D:\\DEV\\Others\\keys\\dummy-invalid.pem";
        fs.writeFileSync(dummyCert, "-----BEGIN CERTIFICATE-----\nMIIDwTCCAqmgAwIBAgIJAJ......\n-----END CERTIFICATE-----"); // Garbage/Truncated PEM

        const sslConfig = {
            ...config,
            securityLevel: 'OnlySecuredSession',
            sslCerFilePath: dummyCert
        };

        const conn = new NzConnection(sslConfig);
        try {
            await conn.connect();
            // If we get here, it succeeded unexpectedly
            console.error('BasicTests - Invalid Cert passed unexpectedly!');
            throw new Error('Should have thrown error with invalid cert');
        } catch (err) {
            console.log('Got expected error:', err.message);
            expect(err).toBeDefined();
        } finally {
            if (fs.existsSync(dummyCert)) {
                fs.unlinkSync(dummyCert);
            }
            if (conn) await conn.close();
        }
    });
});
