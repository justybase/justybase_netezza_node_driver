// NzConnection type reference for circular dependency
import { NzDataReader } from './NzDataReader';

interface NzConnection {
    execute(command: NzCommand, bufferOnly: boolean): Promise<boolean>;
    executeReader(command: NzCommand): Promise<NzDataReader>;
    cancel(): Promise<void>;
    commandTimeout?: number;
}

interface PreparedStatement {
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
    _preparedStatement?: PreparedStatement;
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
}

export { NzCommand };
