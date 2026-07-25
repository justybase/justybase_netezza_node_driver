// NzConnection type reference for circular dependency
import { NzDataReader } from './NzDataReader';

interface NzConnection {
    execute(command: NzCommand, bufferOnly?: boolean): Promise<boolean>;
    executeReader(command: NzCommand): Promise<NzDataReader>;
    cancel(): Promise<void>;
    commandTimeout?: number;
}

/** Cached textual row description from a prior RowDescription message (not a server prepared statement). */
interface CachedRowDescription {
    description?: ColumnInfo[];
}

interface ColumnInfo {
    name: string;
    typeOid: number;
    typeLen: number;
    typeMod: number;
    format: number;
}

/**
 * Represents a SQL command to be executed against Netezza database
 */
class NzCommand {
    connection: NzConnection;
    commandText: string;
    parameters: unknown[];
    _recordsAffected: number;
    commandTimeout: number;
    /** Cached column metadata from the last RowDescription (client-side cache only). */
    _cachedRowDescription?: CachedRowDescription;
    /** Server notices/warnings collected during the last execution */
    _notices: string[] = [];

    constructor(connection: NzConnection) {
        this.connection = connection;
        this.commandText = '';
        this.parameters = [];
        this._recordsAffected = -1;
        this.commandTimeout = connection.commandTimeout !== undefined ? connection.commandTimeout : 30; // Default 30s, 0 = no timeout
    }

    /** Server notices/warnings collected during the last execution */
    get notices(): readonly string[] {
        return this._notices;
    }

    async execute(): Promise<boolean> {
        this._notices = [];
        return this.connection.execute(this, false);
    }

    async executeNonQuery(): Promise<number> {
        this._notices = [];
        await this.connection.execute(this, false);
        return this._recordsAffected;
    }

    async executeReader(): Promise<NzDataReader> {
        this._notices = [];
        return this.connection.executeReader(this);
    }

    async cancel(): Promise<void> {
        return this.connection.cancel();
    }

    /**
     * Set parameters for client-side placeholder substitution ($1, $2, ...).
     *
     * Values are escaped and interpolated into the SQL text before send.
     * This is NOT server-side prepared/bind parameters. Escaping reduces common
     * injection risks for supported primitive types, but is not a guarantee
     * against all injection if values or SQL are misused.
     *
     * @example
     * ```typescript
     * const cmd = connection.createCommand('SELECT * FROM users WHERE id = $1 AND active = $2');
     * cmd.setParameters(42, true);
     * const reader = await cmd.executeReader();
     * ```
     */
    setParameters(...params: unknown[]): this {
        this.parameters = params;
        return this;
    }

    /**
     * Add a single parameter value (client-side escaped interpolation; see setParameters).
     */
    addParameter(value: unknown): this {
        this.parameters.push(value);
        return this;
    }
}

export { NzCommand };
