import type { NzConnectionConfig } from './NzConnection';

/**
 * Parse a Netezza connection URI into NzConnectionConfig.
 *
 * Supported forms:
 * - netezza://user:pass@host:5480/database?sslmode=require&appName=myapp
 * - nz://user:pass@host/database
 *
 * Query keys map onto NzConnectionConfig (camelCase or snake_case).
 */
export function parseConnectionString(connectionString: string): NzConnectionConfig {
    const trimmed = connectionString.trim();
    let url: URL;
    try {
        // URL requires a known scheme; normalize aliases
        const normalized = trimmed.replace(/^(nz|netezza):\/\//i, 'http://');
        url = new URL(normalized);
    } catch {
        throw new Error(`Invalid connection string: ${connectionString}`);
    }

    if (!url.hostname) {
        throw new Error('Connection string must include a host');
    }

    const database = decodeURIComponent((url.pathname || '').replace(/^\//, ''));
    if (!database) {
        throw new Error('Connection string must include a database path, e.g. netezza://user:pass@host/db');
    }

    const config: NzConnectionConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : undefined,
        database,
        user: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || ''),
    };

    if (!config.user) {
        throw new Error('Connection string must include a user');
    }

    for (const [key, value] of url.searchParams.entries()) {
        switch (key.toLowerCase()) {
            case 'securitylevel':
            case 'security_level':
                config.securityLevel = value;
                break;
            case 'sslcerfilepath':
            case 'ssl_cert':
            case 'sslcert':
                config.sslCerFilePath = value;
                break;
            case 'rejectunauthorized':
            case 'reject_unauthorized':
                config.rejectUnauthorized = value === 'true' || value === '1';
                break;
            case 'sslmode':
                if (value === 'disable') {
                    config.securityLevel = 'OnlyUnsecuredSession';
                } else if (value === 'require' || value === 'verify-ca' || value === 'verify-full') {
                    config.securityLevel = 'OnlySecuredSession';
                    if (value === 'require') config.rejectUnauthorized = false;
                }
                break;
            case 'connectiontimeout':
            case 'connection_timeout':
                config.connectionTimeout = parseInt(value, 10);
                break;
            case 'appname':
            case 'application_name':
                config.appName = value;
                break;
            case 'osuser':
            case 'os_user':
                config.osUser = value;
                break;
            case 'clienthostname':
            case 'client_hostname':
                config.clientHostName = value;
                break;
            default:
                break;
        }
    }

    return config;
}
